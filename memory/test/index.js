// Entry for `node --test memory/test/`. Recent Node versions load a directory argument as a module (index.js), so this
// file pulls in every *.test.cjs; each file also runs standalone (`node --test memory/test/core.test.cjs`).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".test.cjs")).sort()) require(path.join(__dirname, f));
