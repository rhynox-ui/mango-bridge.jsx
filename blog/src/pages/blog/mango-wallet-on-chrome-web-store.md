---
layout: ../../layouts/BlogPost.astro
title: "Mango Wallet is live on the Chrome Web Store"
description: "The Mango Wallet browser extension is a real, live, non-custodial wallet — install it and connect to any dApp."
date: "2026-08-29"
---

Mango Wallet is a real, live browser extension — not a "coming soon" placeholder. You can install it today from the [Chrome Web Store](https://chromewebstore.google.com/detail/nphpjgifdodfhachompmknpdjnhomkcc).

A few things worth being precise about, since it's easy to assume otherwise:

- **The extension is the actual wallet.** Onboarding, account management, and transaction signing all happen there.
- **mangoprotocol.site itself doesn't run a second wallet.** The site's Wallet tab is a pointer to the extension, not a duplicate implementation — only an installed extension can inject a provider into other pages, so that's the only thing that can actually connect Mango to a third-party dApp.
- **It's non-custodial**, same principle as the rest of Mango's stack: your keys stay in the extension, on your device.

If you've used the site's Wallet tab before and it just said "install the extension," that's exactly why — now it does.
