# Jumia Phone Tracker

Daily-updated price tracker for ₦120k–250k smartphones on Jumia Nigeria, with full specs.

- **Scrapes** Jumia Nigeria's smartphone category daily
- **Filters** to phones priced between ₦120,000 and ₦250,000
- **Extracts** full specifications from each product page
- **Tracks** price history over time
- **Publishes** results to GitHub Pages

## How it works

A GitHub Actions workflow runs daily at 6 AM UTC (7 AM Lagos time), scraping Jumia via the WebScraping.AI API and committing results to `data/phones.json`. The frontend at `index.html` reads that data and renders it client-side.

## Manual trigger

Go to [Actions](https://github.com/sxottphilip/jumia-phone-tracker/actions) → click **Scrape Jumia Phones** → **Run workflow**.

## Live page

https://sxottphilip.github.io/jumia-phone-tracker/
