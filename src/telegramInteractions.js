/*
 * Server-side state for Telegram buttons and text prompts.
 *
 * Telegram callback payloads are small and user-controlled once delivered, so
 * buttons do not carry the full operation or target object. A button carries an
 * opaque interaction id plus a short choice id; the authoritative choices and
 * payload remain in the user's session.
 *
 * Every lookup re-validates chat id, Telegram user id, interaction kind, status
 * and expiry. This prevents an old button, forwarded callback or stale message
 * from being accepted in a different interaction context.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function newId() {
  return randomBytes(9).toString("base64url");
}

/** Start a callback-driven interaction and replace any previous pending one. */
export function beginInteraction(ctx, kind, choices = {}, options = {}) {
  ctx.session ??= {};
  const now = Date.now();
  const id = newId();
  ctx.session.pendingInteraction = {
    id,
    kind,
    actorChatId: String(ctx.chat?.id ?? ""),
    actorUserId: String(ctx.from?.id ?? ""),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    status: "pending",
    choices,
    payload: options.payload ?? null
  };
  return ctx.session.pendingInteraction;
}

/**
 * Resolve a pending interaction only when it still belongs to the current actor
 * and context. Returning null is intentional for stale/invalid callbacks; the
 * caller should treat that as an expired interaction rather than guessing.
 */
export function getInteraction(ctx, id, kind, choiceId = null) {
  const interaction = ctx.session?.pendingInteraction;
  const expiresAt = new Date(interaction?.expiresAt).getTime();
  if (
    !interaction ||
    interaction.id !== id ||
    interaction.kind !== kind ||
    interaction.status !== "pending" ||
    interaction.actorChatId !== String(ctx.chat?.id ?? "") ||
    interaction.actorUserId !== String(ctx.from?.id ?? "") ||
    !Number.isFinite(expiresAt) ||
    expiresAt < Date.now()
  ) {
    return null;
  }

  if (choiceId === null) {
    return interaction;
  }

  const choice = interaction.choices?.[choiceId];
  return choice ? { interaction, choice } : null;
}

/** Mark a validated interaction as single-use. */
export function consumeInteraction(ctx, id, kind) {
  const interaction = getInteraction(ctx, id, kind);
  if (!interaction) {
    return null;
  }
  interaction.status = "consumed";
  return interaction;
}

/** Clear both button and text interaction state, as used by `/cancel`. */
export function cancelInteractions(ctx) {
  if (ctx.session) {
    ctx.session.pendingInteraction = null;
    ctx.session.pendingTextInput = null;
  }
}

/**
 * Text prompts use the same identity/expiry machinery as buttons. The small
 * `pendingTextInput` record is only a pointer to the authoritative interaction.
 */
export function beginTextInput(ctx, kind, options = {}) {
  const interaction = beginInteraction(ctx, `text:${kind}`, {}, options);
  ctx.session.pendingTextInput = {
    id: interaction.id,
    kind,
    expiresAt: interaction.expiresAt
  };
  return interaction;
}

export function getTextInput(ctx, kind) {
  const pending = ctx.session.pendingTextInput;
  if (!pending || pending.kind !== kind) {
    return null;
  }
  return getInteraction(ctx, pending.id, `text:${kind}`);
}

/** Consume a text prompt once; repeated messages cannot reuse the same prompt. */
export function consumeTextInput(ctx, kind) {
  const pending = ctx.session.pendingTextInput;
  if (!pending || pending.kind !== kind) {
    return null;
  }
  const interaction = consumeInteraction(ctx, pending.id, `text:${kind}`);
  if (interaction) {
    ctx.session.pendingTextInput = null;
  }
  return interaction;
}

/** Build the compact callback payload placed on an inline Telegram button. */
export function interactionCallback(prefix, interactionId, choiceId = "go") {
  return `${prefix}:${interactionId}:${choiceId}`;
}
