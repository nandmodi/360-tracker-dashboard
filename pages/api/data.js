export default async function handler(req, res) {
  const UUID = "7f9326d8-9eb9-4cc2-bded-efb1aac967db";
  const METABASE_URL = `https://metabase.spyne.ai/api/public/card/${UUID}/query/json`;

  try {
    const response = await fetch(METABASE_URL);

    if (!response.ok) {
      return res.status(500).json({ error: `Metabase error: ${response.status}` });
    }

    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate");
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
