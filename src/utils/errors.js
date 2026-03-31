// src/utils/errors.js

function sendError(res, httpStatus, code, message, extras) {
  const payload = { error: { code, message } };
  if (extras && typeof extras === "object") payload.error = { ...payload.error, ...extras };
  return res.status(httpStatus).json(payload);
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
