import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeGenerated } from "./write-generated.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const raw = execFileSync(
	"cargo",
	["run", "--quiet", "-p", "pilo-runtime", "--example", "host_api_methods"],
	{
		cwd: root,
		encoding: "utf8",
	},
);
const data = JSON.parse(raw);

writeGenerated(
	new URL("../shared/api/host-methods.json", import.meta.url),
	data,
	"pnpm generate:host-api",
);
