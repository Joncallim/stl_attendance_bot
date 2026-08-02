import test from "node:test";
import assert from "node:assert/strict";
import {
  beginInteraction,
  beginTextInput,
  cancelInteractions,
  consumeInteraction,
  getInteraction,
  getTextInput
} from "../src/telegramInteractions.js";

function context() {
  return {
    chat: { id: "chat-1" },
    from: { id: "user-1" },
    session: {}
  };
}

test("a new interaction invalidates old Telegram menu choices", () => {
  const ctx = context();
  const first = beginInteraction(ctx, "admin-add-admin", { a: { appointment: "ALPHA" } });
  const second = beginInteraction(ctx, "admin-add-admin", { a: { appointment: "BRAVO" } });

  assert.equal(getInteraction(ctx, first.id, "admin-add-admin", "a"), null);
  assert.equal(getInteraction(ctx, second.id, "admin-add-admin", "a").choice.appointment, "BRAVO");
  assert.ok(consumeInteraction(ctx, second.id, "admin-add-admin"));
  assert.equal(getInteraction(ctx, second.id, "admin-add-admin", "a"), null);
});

test("text input is actor-bound and is cancelled by navigation", () => {
  const ctx = context();
  beginTextInput(ctx, "appointment");
  assert.ok(getTextInput(ctx, "appointment"));
  ctx.from.id = "different-user";
  assert.equal(getTextInput(ctx, "appointment"), null);
  ctx.from.id = "user-1";
  cancelInteractions(ctx);
  assert.equal(getTextInput(ctx, "appointment"), null);
});

test("interactions with a missing or malformed expiry fail closed", () => {
  const ctx = context();
  const interaction = beginInteraction(ctx, "admin-deregister", {
    a: { appointment: "ALPHA" }
  });

  delete ctx.session.pendingInteraction.expiresAt;
  assert.equal(getInteraction(ctx, interaction.id, "admin-deregister", "a"), null);

  ctx.session.pendingInteraction.expiresAt = "not-a-date";
  assert.equal(getInteraction(ctx, interaction.id, "admin-deregister", "a"), null);
});
