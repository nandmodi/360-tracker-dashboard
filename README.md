# 360 Dashboard

A live dashboard built with Next.js, powered by Metabase data, deployed on Vercel.

## Features
- Live data from Metabase public question
- KPI summary cards
- Bar chart & Line chart views
- Data table with search
- Auto-refresh

## Setup

1. Clone this repo
2. Run `npm install`
3. Run `npm run dev` — open http://localhost:3000

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to vercel.com → New Project → Import this repo
3. Framework: Next.js (auto-detected)
4. Click Deploy

## Data Source

Metabase public question:
`https://metabase.spyne.ai/api/public/card/7f9326d8-9eb9-4cc2-bded-efb1aac967db/query/json`

To change the data source, update `pages/api/data.js`.
