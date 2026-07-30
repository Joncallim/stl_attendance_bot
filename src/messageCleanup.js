import { createHash, randomUUID } from "node:crypto";
import { getDataFile } from "./dataDir.js";
import { readJsonFile, runSerialized, writeJsonFile } from "./fileStore.js";
import { allSettledConcurrent } from "./concurrency.js";

export const ATTENDANCE_BUTTON_TTL_MS = 60 * 60 * 1000;
const CLEANUP_CONCURRENCY = 10;
const CLEANUP_STATE_VERSION = 1;
const CLEANUP_STATE_MUTEX_KEY = "attendance-button-cleanup-state";
const CLEANUP_SWEEP_MUTEX_KEY = "attendance-button-cleanup-sweep";
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

function getCleanupFile() {
  return getDataFile("attendance-button-cleanup.json");
}

function buildJobId(chatId, messageId) {
  return createHash("sha256")
    .update(`${String(chatId)}\u0000${String(messageId)}`, "utf8")
    .digest("hex");
}

function validateCleanupState(value) {
  if (
    !value ||
    value.version !== CLEANUP_STATE_VERSION ||
    !Array.isArray(value.jobs)
  ) {
    throw new Error("Invalid attendance button cleanup state; refusing unsafe recovery.");
  }

  for (const job of value.jobs) {
    const messageId = Number(job?.messageId);
    const removeAfter = Date.parse(job?.removeAfter ?? "");
    const nextAttemptAt = Date.parse(job?.nextAttemptAt ?? "");

    if (
      !job ||
      !String(job.chatId ?? "").trim() ||
      !Number.isInteger(messageId) ||
      messageId <= 0 ||
      !String(job.scheduleId ?? "").trim() ||
      !Number.isFinite(removeAfter) ||
      (
        job.nextAttemptAt !== null &&
        job.nextAttemptAt !== undefined &&
        !Number.isFinite(nextAttemptAt)
      ) ||
      job.id !== buildJobId(job.chatId, messageId)
    ) {
      throw new Error("Invalid attendance button cleanup job; refusing unsafe recovery.");
    }
  }

  return value;
}

async function readCleanupState() {
  const state = await readJsonFile(getCleanupFile(), {
    version: CLEANUP_STATE_VERSION,
    jobs: []
  });
  return validateCleanupState(state);
}

function getTelegramErrorCode(error) {
  return Number(
    error?.code ??
    error?.response?.error_code ??
    error?.response?.status ??
    error?.status
  );
}

function isPermanentTelegramEditError(error) {
  const code = getTelegramErrorCode(error);
  return code === 400 || code === 403;
}

async function removeInlineKeyboard(telegram, job, signal) {
  if (typeof telegram.callApi === "function") {
    return telegram.callApi(
      "editMessageReplyMarkup",
      {
        chat_id: job.chatId,
        message_id: job.messageId,
        reply_markup: { inline_keyboard: [] }
      },
      { signal }
    );
  }

  return telegram.editMessageReplyMarkup(
    job.chatId,
    job.messageId,
    undefined,
    { inline_keyboard: [] }
  );
}

export async function scheduleAttendanceButtonCleanup(
  chatId,
  messageId,
  completedAt = new Date()
) {
  const normalizedMessageId = Number(messageId);
  const completedAtMs = new Date(completedAt).getTime();

  if (
    !String(chatId ?? "").trim() ||
    !Number.isInteger(normalizedMessageId) ||
    normalizedMessageId <= 0 ||
    !Number.isFinite(completedAtMs)
  ) {
    return null;
  }

  const job = {
    id: buildJobId(chatId, normalizedMessageId),
    scheduleId: randomUUID(),
    chatId: String(chatId),
    messageId: normalizedMessageId,
    createdAt: new Date(completedAtMs).toISOString(),
    removeAfter: new Date(completedAtMs + ATTENDANCE_BUTTON_TTL_MS).toISOString(),
    retryCount: 0,
    nextAttemptAt: null
  };

  await runSerialized(CLEANUP_STATE_MUTEX_KEY, async () => {
    const state = await readCleanupState();
    const jobs = state.jobs.filter((entry) => entry.id !== job.id);
    jobs.push(job);
    await writeJsonFile(getCleanupFile(), {
      version: CLEANUP_STATE_VERSION,
      jobs
    });
  });

  return job;
}

export async function listPendingAttendanceButtonCleanups() {
  return runSerialized(CLEANUP_STATE_MUTEX_KEY, async () => {
    const state = await readCleanupState();
    return state.jobs.map((job) => ({ ...job }));
  });
}

export async function cancelAttendanceButtonCleanup(chatId, messageId) {
  const normalizedMessageId = Number(messageId);

  if (
    !String(chatId ?? "").trim() ||
    !Number.isInteger(normalizedMessageId) ||
    normalizedMessageId <= 0
  ) {
    return false;
  }

  const jobId = buildJobId(chatId, normalizedMessageId);

  return runSerialized(CLEANUP_STATE_MUTEX_KEY, async () => {
    const state = await readCleanupState();
    const jobs = state.jobs.filter((job) => job.id !== jobId);

    if (jobs.length === state.jobs.length) {
      return false;
    }

    await writeJsonFile(getCleanupFile(), {
      version: CLEANUP_STATE_VERSION,
      jobs
    });
    return true;
  });
}

export async function cleanupExpiredAttendanceButtons(
  telegram,
  { now = new Date(), concurrency = CLEANUP_CONCURRENCY } = {}
) {
  return runSerialized(CLEANUP_SWEEP_MUTEX_KEY, async () => {
    const nowMs = new Date(now).getTime();

    if (!Number.isFinite(nowMs)) {
      throw new Error("Invalid cleanup timestamp.");
    }

    const dueJobs = await runSerialized(CLEANUP_STATE_MUTEX_KEY, async () => {
      const state = await readCleanupState();
      return state.jobs
        .filter((job) => {
          const removeAfter = Date.parse(job.removeAfter);
          const nextAttemptAt = Date.parse(job.nextAttemptAt ?? "");
          return (
            Number.isFinite(removeAfter) &&
            removeAfter <= nowMs &&
            (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= nowMs)
          );
        })
        .map((job) => ({ ...job }));
    });

    if (dueJobs.length === 0) {
      return { attempted: 0, removed: 0, retired: 0, retrying: 0 };
    }

    const results = await allSettledConcurrent(
      dueJobs.map((job) => (signal) => removeInlineKeyboard(telegram, job, signal)),
      concurrency
    );
    let removed = 0;
    let retired = 0;
    let retrying = 0;

    await runSerialized(CLEANUP_STATE_MUTEX_KEY, async () => {
      const state = await readCleanupState();
      const jobsById = new Map(state.jobs.map((job) => [job.id, job]));

      for (let index = 0; index < results.length; index += 1) {
        const attemptedJob = dueJobs[index];
        const currentJob = jobsById.get(attemptedJob.id);

        // A newer attendance submission can reuse the same Telegram message.
        // Never let an older in-flight cleanup remove or delay its newer job.
        if (!currentJob || currentJob.scheduleId !== attemptedJob.scheduleId) {
          continue;
        }

        const result = results[index];

        if (result.status === "fulfilled") {
          jobsById.delete(attemptedJob.id);
          removed += 1;
          continue;
        }

        if (isPermanentTelegramEditError(result.reason)) {
          jobsById.delete(attemptedJob.id);
          retired += 1;
          continue;
        }

        const retryCount = Number(currentJob.retryCount ?? 0) + 1;
        const retryDelayMs = Math.min(
          RETRY_MAX_MS,
          RETRY_BASE_MS * (2 ** Math.min(retryCount - 1, 6))
        );
        jobsById.set(currentJob.id, {
          ...currentJob,
          retryCount,
          nextAttemptAt: new Date(nowMs + retryDelayMs).toISOString()
        });
        retrying += 1;
      }

      await writeJsonFile(getCleanupFile(), {
        version: CLEANUP_STATE_VERSION,
        jobs: [...jobsById.values()]
      });
    });

    return {
      attempted: dueJobs.length,
      removed,
      retired,
      retrying
    };
  });
}

export const __testing = {
  buildJobId,
  isPermanentTelegramEditError
};
