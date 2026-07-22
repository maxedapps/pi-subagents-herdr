import { fileURLToPath } from "node:url";
import { loadProfileCatalog } from "../src/profiles.ts";

export const TEST_PROFILES = loadProfileCatalog({
  bundledDir: fileURLToPath(new URL("../agents", import.meta.url)),
  userDir: fileURLToPath(new URL(".missing-herdr-profile-directory", import.meta.url)),
});
