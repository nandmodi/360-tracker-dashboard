const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
const BASE = "https://metabase.spyne.ai";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const endpoints = [
    `${BASE}/api/public/card/${UUID}/query/json`,
    `${BASE}/api/public/card/${UUID}/query`,
  ];

  const results = {};

  for (const url of endpoints) {
    try {
      const r    = await fetch(url);
      const text = await r.text();
      results[url] = {
        status:      r.status,
        contentType: r.headers.get("content-type"),
        preview:     text.slice(0, 800),
        length:      text.length,
      };
    } catch (e) {
      results[url] = { error: e.message };
    }
  }

  res.status(200).json(results);
};
