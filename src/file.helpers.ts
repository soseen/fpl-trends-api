import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Manual implementation of __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES_FOLDER = path.join(__dirname, "data");

export const RAW_BOOTSTRAP_STATIC_FILE = path.join(
  FILES_FOLDER,
  "raw_bootstrap_static.json",
);
export const RAW_FOOTBALLERS_FILE = path.join(
  FILES_FOLDER,
  "raw_footballers.json",
);

if (!fs.existsSync(FILES_FOLDER)) {
  fs.mkdirSync(FILES_FOLDER, { recursive: true });
  console.info(`Created folder: ${FILES_FOLDER}`);
}
