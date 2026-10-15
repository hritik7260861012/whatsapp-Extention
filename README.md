# ✨ WhatsApp Clean UI

### 🧹 A cleaner, simpler WhatsApp Web experience

Hide the **Updates / Status** and **Communities** navigation items on WhatsApp Web and enjoy a cleaner sidebar — without changing your chats, calls, or messages.

<p align="center">
  <strong>Lightweight • Privacy-focused • No Build Step • No Dependencies</strong>
</p>

---

## 📌 About the Project

**WhatsApp Clean UI** is a lightweight browser extension built with JavaScript, HTML, and CSS using the **Manifest V3** extension platform.

It lets you hide the navigation items you don't want to see on WhatsApp Web. Both options can be controlled independently from the extension popup.

The extension is designed to change the interface only. It does not intentionally delete WhatsApp elements or modify your conversations.

## ✨ Features

- 🟢 **Hide Updates / Status** — remove the Updates/Status navigation item from the sidebar.
- 👥 **Hide Communities** — hide the Communities navigation item.
- 🎛️ **Independent Toggles** — choose which navigation items to hide.
- 💾 **Saved Preferences** — remember your toggle settings using local browser storage.
- ⚡ **Dynamic UI Handling** — reapply hiding when WhatsApp Web updates or re-renders its interface.
- 🔒 **Privacy-focused** — no account login, credentials, or message access is required by the extension's intended functionality.
- 🪶 **Lightweight** — plain JavaScript, HTML, and CSS.
- 🧩 **Manifest V3** — designed for Chromium-based browsers such as Microsoft Edge and Google Chrome.
- 🚫 **No Build Step** — no compilation or bundling is required.
- 📦 **No External Dependencies** — no package installation is required to load the extension.

> Note: WhatsApp Web may change its interface at any time. If its navigation structure changes, the extension may require an update.

## 🖥️ Supported Browsers

- Microsoft Edge
- Google Chrome
- Other Chromium-based browsers may work, but have not necessarily been tested.

The extension is intended for use on:

`https://web.whatsapp.com/`

## 📂 Project Structure

```text
Whatsapp-Extention/
│
├── manifest.json       # Extension configuration
├── content.js          # Navigation detection and hiding logic
├── styles.css          # CSS used to hide selected navigation items
├── popup.html          # Extension popup interface
├── popup.css           # Popup styling
├── popup.js            # Toggle controls and saved preferences
├── README.md           # Project documentation
├── PRIVACY.md          # Privacy information
├── TESTING.md          # Testing instructions
├── tests/              # Automated tests
├── tools/
│   └── make-icons.mjs  # Regenerates icons/ from any source PNG
└── icons/              # icon16/32/48/128.png (referenced by manifest.json)
```

## 🚀 Installation Guide

You can install this extension on your own laptop without a build process.

### 🟦 Method 1: Download from GitHub

**Step 1 — Open the repository**

Visit:

[👉 WhatsApp Clean UI on GitHub](https://github.com/hritik7260861012/whatsapp-Extention)

**Step 2 — Download the project**

1. Click the green **Code** button.
2. Select **Download ZIP**.
3. Extract the downloaded ZIP file to a folder on your laptop.

**Step 3 — Open the extensions page**

For Microsoft Edge, enter this in the address bar:

`edge://extensions`

For Google Chrome, enter:

`chrome://extensions`

**Step 4 — Enable Developer mode**

Turn on **Developer mode** on the extensions page.

**Step 5 — Load the extension**

1. Click **Load unpacked**.
2. Select the extracted project folder containing `manifest.json`.
3. Confirm that **WhatsApp Clean UI** appears in your extensions list and is enabled.

**Important:** Select the actual extension folder containing `manifest.json`, not the ZIP file itself and not an unrelated parent folder.

### 🟩 Method 2: Install from a Local Folder

If someone shares the project folder with you:

1. Copy the folder to your laptop.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.

That's it! No Node.js, npm, Python, or build command is required just to load the extension.

## 🎛️ How to Use

1. Open [WhatsApp Web](https://web.whatsapp.com/).
2. Sign in normally if required.
3. Click the browser's **Extensions** icon (usually the puzzle-piece icon).
4. Open or pin **WhatsApp Clean UI** for easy access.
5. Use the popup toggles to control:
   - **Hide Updates / Status**
   - **Hide Communities**
6. If the changes do not appear immediately, refresh WhatsApp Web using `Ctrl + Shift + R`.

### ⚙️ Toggle Behaviour

| Updates / Status | Communities | Expected behaviour |
|---|---|---|
| ON | ON | Hide both items |
| OFF | ON | Show Updates/Status; hide Communities |
| ON | OFF | Hide Updates/Status; show Communities |
| OFF | OFF | Show both items |

*ON means the corresponding item should be hidden. Actual behaviour should be verified against the current WhatsApp Web interface.*

## 🔐 Privacy & Permissions

The extension requests the `storage` permission to save its toggle preferences.

Its content script is configured for `https://web.whatsapp.com/*`, rather than all websites.

The intended functionality does not require:
- Access to your WhatsApp password.
- Reading or exporting your messages.
- Access to your contacts or chat history.
- Sending your data to an external server.
- Analytics or tracking services.

The extension's source code is available in this repository for inspection.

For further details, read [PRIVACY.md](PRIVACY.md).

## 🛠️ Troubleshooting

### Updates/Status or Communities are still visible

1. Open `edge://extensions` or `chrome://extensions`.
2. Confirm that WhatsApp Clean UI is enabled.
3. Open its details page and check that site access is allowed for `https://web.whatsapp.com/`.
4. Open the popup and enable the appropriate hiding toggle.
5. Refresh WhatsApp Web using `Ctrl + Shift + R`.

If the items are still visible, WhatsApp may have changed its page structure. Check the browser extension errors and the project documentation.

### The extension does not load

- Make sure Developer mode is enabled.
- Select the folder containing `manifest.json`.
- Check for missing files or errors on the extensions page.
- Reload the extension after making changes.

### My settings do not apply

- Check that the relevant toggle is enabled.
- Close and reopen the popup.
- Refresh WhatsApp Web.
- If the problem persists, inspect the extension's runtime errors.

## 🧪 Testing

The repository includes a `tests/` directory for automated checks.

To see the available tests and instructions, read [TESTING.md](TESTING.md).

Automated tests do not automatically prove compatibility with the live WhatsApp Web interface. Manual browser testing is also recommended after changes.

## 🤝 Contributing

Contributions, bug reports, and suggestions are welcome.

1. Fork the repository.
2. Create a branch for your change.
3. Make a focused improvement.
4. Run the available tests.
5. Submit a pull request with a clear explanation of the change.

Please avoid adding unnecessary permissions or collecting private WhatsApp data.

## ⚠️ Disclaimer

This is an independent, community-style browser extension project. It is not an official WhatsApp product and is not affiliated with or endorsed by WhatsApp or Meta.

WhatsApp Web's interface may change, so compatibility can vary over time.

## 📄 License

Check the repository for a `LICENSE` file to determine the applicable license before redistributing or modifying the project.

---

<p align="center">
  Made with ❤️ for a cleaner WhatsApp Web experience.
</p>

👨‍💻 Author & Copyright

Created and maintained by Hritik. ❤️

Copyright © 2026 Hritik. All rights reserved.