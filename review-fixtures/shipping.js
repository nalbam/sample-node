// Isolated fixture for the PR webhook review acceptance check. Not imported by the app.
// Contract: orders of at least 100 receive free shipping; smaller orders cost 5.
function shippingFee(total) {
  if (total > 100) return 0;
  return 5;
}

module.exports = { shippingFee };
