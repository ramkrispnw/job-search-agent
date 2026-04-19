// src/utils/config.ts — load and persist user config

import * as fs from "fs-extra";
import { UserConfig, CONFIG_PATH, CONFIG_DIR } from "../config/types.js";

export async function loadConfig(): Promise<UserConfig | null> {
  if (!(await fs.pathExists(CONFIG_PATH))) return null;
  const raw = await fs.readJson(CONFIG_PATH);
  return raw as UserConfig;
}

export async function saveConfig(config: UserConfig): Promise<void> {
  await fs.ensureDir(CONFIG_DIR);
  config.updatedAt = new Date().toISOString();
  await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
}

export async function configExists(): Promise<boolean> {
  return fs.pathExists(CONFIG_PATH);
}
