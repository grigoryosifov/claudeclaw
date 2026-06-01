import { join } from "path";
import { claudeClawDir } from "../paths";

export const HEARTBEAT_DIR = claudeClawDir();
export const LOGS_DIR = join(HEARTBEAT_DIR, "logs");
export const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
export const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");
export const STATE_FILE = join(HEARTBEAT_DIR, "state.json");
