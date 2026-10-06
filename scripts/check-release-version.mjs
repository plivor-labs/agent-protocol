import { readFileSync } from "node:fs";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag?.startsWith("v")) throw new Error("Expected release tag v<version>");

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const pythonVersion = readFileSync("pyproject.toml", "utf8").match(/^version = "([^"]+)"$/m)?.[1];
const tagVersion = tag.slice(1);

if (packageVersion !== tagVersion || pythonVersion !== tagVersion) {
  throw new Error(`Version mismatch: tag=${tagVersion}, npm=${packageVersion}, python=${pythonVersion}`);
}

console.log(`release version ${tagVersion}`);
