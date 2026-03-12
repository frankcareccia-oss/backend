async function loadActiveQrWithStore(prisma, token) {
  return prisma.storeQr.findFirst({
    where: { token, status: "active" },
    include: { store: { include: { merchant: true } } },
  });
}

module.exports = {
  loadActiveQrWithStore,
};