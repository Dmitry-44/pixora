# Pixora: market digest (2026-11-16)

Collected by a background web-research agent. Most sources are vendor blogs and SEO pages; model prices and version names have not been checked against each provider's own page.

## Competitors in Telegram
- **All-in-one bots with many models (most of the RU market):** Syntx AI, MazAI, Uniset AI, STUDIO VVS, BOTARA, GPT Russia, @GPT4Telegrambot. They all sell internal tokens or credits, usually bought with Stars.
- **Free bots from big companies:** @Kandinsky_bot and @GigaChat_bot (Sber). They offer avatar styles and stickers, which caps what users will pay for basic generation.
- **Template bots (closest to Pixora):** NeuroAvatarBot (12+ styles), Kadritsa (portrait looks, 299/499 ₽), ClonixAI (4 selfies make a personal avatar; 299–499 ₽), Head AI, Pikme (100+ templates), AI Lab (~280k monthly users, figure from a third-party catalog).
- **Global bots priced in Stars:** StarGen (from 1⭐ per image), zosee (149⭐ for 30 credits).

## Popular templates outside Telegram
- Portrait styles: Ghibli, anime, chibi.
- 3D action figure in toy packaging.
- LinkedIn-style professional headshots.
- Clay or 3D figurines.
- Magazine cover, Tarot card.
- YouTube thumbnails: 16:9, close-up face, 2–4 words of bold text.

## Model APIs (about 1K resolution, list prices)
| Model | $ per image |
|---|---|
| FLUX schnell / Klein | ~0.001–0.009 |
| GPT Image | 0.006–0.21 (depends on quality) |
| Imagen 4 Fast / Ultra | 0.02 / 0.06 |
| Ideogram | 0.03–0.10 |
| Nano Banana (Gemini) | 0.034–0.134 |
| FLUX 3 | 0.048 |

- **Midjourney:** no official API.
- **OpenAI and Google APIs:** not officially available from Russia (not verified).
- **Strengths (from general knowledge, not checked):** Ideogram and GPT Image render text well; Nano Banana and GPT Image keep a face consistent when working from a reference photo; Flux is cheap.

## Telegram platform rules
- Digital goods must be sold for Telegram Stars only. A bot that breaks this can be hidden from mobile users. https://core.telegram.org/bots/payments-stars
- The developer earns about $0.013 per Star. Withdrawals start at 1,000⭐, Stars can be held for up to 21 days, and payouts go through Fragment.
- Media limits: photos up to 10 MB, files up to 50 MB, `getFile` downloads up to 20 MB, about 1 message per second per chat.

## Risks
- **Pricing:** at $0.013 per Star, an expensive model costs about 10⭐ per image and a cheap one under 1⭐.
- **Moderation:** Telegram has a widespread problem with nudify and deepfake bots. Any template that takes a user's photo needs moderation and possibly a consent step.
- **Crowded market:** to stand out, Pixora needs niche templates of high quality, not just access to models.
- **Telegram blocking in Russia (since Feb 2026):** bots hosted on Russian servers can lose access to the API. Competitors are moving to MAX, which requires a Russian legal entity or sole proprietor.
