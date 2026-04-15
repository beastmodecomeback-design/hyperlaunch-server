name: Sync pump.fun tokens

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
    inputs:
      mode:
        description: 'sync mode (recent or deep)'
        default: 'recent'

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install deps
        run: npm install
      - name: Run sync
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SECRET: ${{ secrets.SUPABASE_SECRET }}
        run: node server.js ${{ github.event.inputs.mode || 'recent' }}
