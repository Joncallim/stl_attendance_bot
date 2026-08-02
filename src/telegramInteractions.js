import { randomBytes } from "node:crypto";

// Telegram callback data is deliberately kept small.  The complete target and
// its expected state stay server-side in the user's session; buttons only carry
// this opaque interaction id and a short choice id.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function newId() {
  return randomBytes(9).toString("base64url");
}

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

export function consumeInteraction(ctx, id, kind) {
  const interaction = getInteraction(ctx, id, kind);
  if (!interaction) {
    return null;
  }
  interaction.status = "consumed";
  return interaction;
}

export function cancelInteractions(ctx) {
  if (ctx.session) {
    ctx.session.pendingInteraction = null;
    ctx.session.pendingTextInput = null;
  }
}

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

export function interactionCallback(prefix, interactionId, choiceId = "go") {
  return `${prefix}:${interactionId}:${choiceId}`;
}
