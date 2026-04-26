// src/utils/errors.js

function sendError(res, httpStatus, code, message, extras) {
  // Auto-generate a stable i18n key from code + message for frontend translation
  const errorKey = "errors." + code.toLowerCase() + "." + slugify(message);
  const payload = { error: { code, message, errorKey } };
  if (extras && typeof extras === "object") payload.error = { ...payload.error, ...extras };
  return res.status(httpStatus).json(payload);
}

/** Turn a message into a stable camelCase slug for i18n key lookup */
function slugify(msg) {
  if (!msg || typeof msg !== "string") return "unknown";
  return msg
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6) // cap at 6 words to keep keys short
    .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function handlePrismaError(err, res) {
  const code = err?.code;

  if (code === "P2002") {
    const target = err?.meta?.target;
    return sendError(res, 409, "UNIQUE_VIOLATION", "Unique constraint violation", target ? { target } : undefined);
  }

  if (code === "P2003") {
    const field = err?.meta?.field_name;
    return sendError(res, 409, "FK_VIOLATION", "Foreign key constraint violation", field ? { field } : undefined);
  }

  if (code === "P2025") {
    return sendError(res, 404, "NOT_FOUND", "Record not found");
  }

  return sendError(res, 400, "BAD_REQUEST", err?.message || "Request failed");
}

module.exports = { sendError, handlePrismaError };
