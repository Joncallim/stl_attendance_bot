import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

const REQUIRED_ENV = {
  GOOGLE_PRIVATE_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "test-token",
  GOOGLE_SHEETS_SPREADSHEET_ID: "test-sheet",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@example.com"
};

for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  process.env[name] ??= value;
}

test("settings.yaml drives default admins, hierarchy, and attendance options", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-config-"));
  const settingsPath = path.join(tempDir, "settings.yaml");

  await writeFile(settingsPath, [
    "schemaVersion: 1",
    "unit:",
    "  id: alpha",
    "  name: Alpha Unit",
    "hierarchy:",
    "  - id: hq",
    "    name: HQ",
    "    type: department",
    "    order: 0",
    "  - id: ops",
    "    name: Ops Section",
    "    type: section",
    "    parentId: hq",
    "    order: 1",
    "appointments:",
    "  - name: CO",
    "    hierarchyNodeId: hq",
    "    defaultAdmin: true",
    "    order: 0",
    "  - name: OPS 1",
    "    hierarchyNodeId: ops",
    "    order: 1",
    "attendance:",
    "  groups:",
    "    - id: present",
    "      label: Present",
    "      summaryLabel: Total PRESENT",
    "      options:",
    "        - PRESENT",
    "        - DUTY",
    "    - id: leave",
    "      label: Leave",
    "      options:",
    "        - LL",
    "        - OL"
  ].join("\n"));

  process.env.SETTINGS_FILE_PATH = settingsPath;
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    const module = await import(`../src/config.js?case=${Date.now()}`);
    const appliedConfig = await module.applyStoredConfigOverrides();

    assert.equal(appliedConfig.unit.name, "Alpha Unit");
    assert.deepEqual(appliedConfig.defaultAdminAppointments, ["CO"]);
    assert.deepEqual(appliedConfig.onboardingAttendanceOptions, ["PRESENT", "DUTY", "LL", "OL"]);
    assert.deepEqual(appliedConfig.attendanceOptions, ["PRESENT", "DUTY", "LL", "OL"]);
    assert.equal(appliedConfig.hierarchy[0].label, "HQ");
    assert.equal(appliedConfig.hierarchy[1].parentId, "hq");
    assert.equal(
      appliedConfig.appointmentMetadataByName.get("OPS 1").hierarchyNodeKey,
      "OPS"
    );
  } finally {
    delete process.env.SETTINGS_FILE_PATH;
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("invalid settings.yaml fails fast with a clear validation error", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-config-invalid-"));
  const settingsPath = path.join(tempDir, "settings.yaml");

  await writeFile(settingsPath, [
    "schemaVersion: 1",
    "unit:",
    "  name: Broken Unit",
    "hierarchy:",
    "  - id: dept",
    "    name: Department",
    "    type: department",
    "appointments:",
    "  - name: ALPHA",
    "    hierarchyNodeId: missing-node",
    "attendance:",
    "  groups:",
    "    - id: present",
    "      label: Present",
    "      options:",
    "        - PRESENT"
  ].join("\n"));

  process.env.SETTINGS_FILE_PATH = settingsPath;
  process.env.ATTENDANCE_BOT_DATA_DIR = tempDir;

  try {
    const module = await import(`../src/config.js?case=invalid-${Date.now()}`);

    await assert.rejects(
      () => module.loadUnitSettings(),
      /references missing hierarchy node 'missing-node'/
    );
  } finally {
    delete process.env.SETTINGS_FILE_PATH;
    delete process.env.ATTENDANCE_BOT_DATA_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
});
