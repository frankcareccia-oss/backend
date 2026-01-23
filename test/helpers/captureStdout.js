"use strict";

// Capture stdout (and optionally stderr) during a test and return collected lines.
function captureStdout() {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const output = [];

  process.stdout.write = (chunk, encoding, cb) => {
    output.push(String(chunk));
    return originalOut(chunk, encoding, cb);
  };

  process.stderr.write = (chunk, encoding, cb) => {
    output.push(String(chunk));
    return originalErr(chunk, encoding, cb);
  };

  return {
    output,
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

// Back-compat aliases (some files call these older names)
function captureConsoleLogs() {
  return captureStdout();
}

function logsContain(lines, ...needles) {
  const joined = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  return needles.every((n) => joined.includes(n));
}

module.exports = {
  captureStdout,
  captureConsoleLogs,
  logsContain,
};
