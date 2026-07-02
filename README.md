# Autocreative
AI Marketing Autopilot — Qwen + wan2.6-i2v + Google Apps Script

# AutoCreative — AI Marketing Autopilot

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Built with Qwen](https://img.shields.io/badge/Built%20with-Qwen--Plus-blue)](https://dashscope.aliyuncs.com)
[![Alibaba Cloud](https://img.shields.io/badge/Alibaba%20Cloud-DashScope-orange)](https://dashscope.aliyuncs.com)

> A client fills a form in 5 minutes. In under 2 minutes they have a promo video with real narration, bilingual copies for every platform, and a review email — all generated autonomously by AI.


## How it works

1. Client fills a bilingual form (ES/EN auto-detected)adding a product image 
2. **Qwen-Plus** generates strategy, hook, bilingual copy + hashtags per platform, voiceover script, and visual prompt with audio direction
3. **wan2.6-i2v** animates the product image into a promo video with real narration (~60 seconds)
4. Client receives a review email with copies, video preview, and Approve / Request Changes buttons
5. On approval → final 720P video generated and delivered

## Tech Stack

| Component | Service |
|---|---|
| Orchestrator | Google Apps Script |
| Copy generation | Qwen-Plus (DashScope International) |
| Video + narration | wan2.6-i2v (DashScope International) |
| Asset storage | Google Drive + Alibaba OSS |
| Email delivery | Gmail API |

## Setup

### Prerequisites
- Google account with Apps Script access
- Alibaba Cloud account with DashScope access
- API key with Qwen-Plus and wan2.6-i2v enabled

### Script Properties required

| Property | Description |
|---|---|
| `DASHSCOPE_API_KEY` | DashScope API key (Singapore/International) |
| `DASHSCOPE_VIDEO_KEY` | DashScope API key for video (falls back to above) |
| `APPROVER_EMAIL` | Email to receive campaign reviews |
| `PUBLIC_IMAGE_FOLDER_ID` | Google Drive folder ID (public, Anyone with link) |
| `WEBAPP_URL` | Deployed Web App URL |

### Deploy
1. Create a new Google Apps Script project
2. Copy `MarketingAgent.gs` and `index.html` into the project
3. Set Script Properties above
4. Deploy as Web App → Execute as Me → Anyone can access
5. Copy the Web App URL into `WEBAPP_URL` property

## License

MIT — see [LICENSE](LICENSE)
