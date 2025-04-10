module.exports = (req, res, next) => {
  // Add CORS headers
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")

  // Add a small delay to simulate network latency
  setTimeout(next, 300)
}
