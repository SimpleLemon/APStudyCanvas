# Privacy Policy

**Last Updated:** May 2, 2026

## Overview

Canvas Refined ("the Extension") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and protect your information.

TLDR: we store some of your canvas info locally on your device and it stays fully local

## What We Collect

### 1. User Preferences and Settings
The Extension stores user preferences and customization settings locally on your device, including:
- Dark mode preferences and color themes
- Dashboard customization options
- Feature toggles (assignments due list, GPA calculator, etc.)
- Custom fonts and UI preferences

These settings are stored locally using Chrome's `chrome.storage` API and synced across your Chrome profile if you enable sync.

### 2. Canvas Data
The Extension accesses information from your Canvas instance to provide enhanced features:
- Assignment information and due dates
- Grade and GPA data
- Announcements
- Course and grade information
- Dashboard content

**Important:** This data is retrieved directly from Canvas when you access it and is processed locally on your device. We do not transmit or store this data on external servers.

### Notification History
Notification preferences and inbox history are stored on this device, separately for each Canvas account. The extension checks authenticated, open Canvas tabs for announcements, published assignment grades, assignment deadlines, and personal planner tasks. It retains up to 200 inbox items for 30 days and source/delivery markers for up to 90 days to prevent duplicate alerts. Optional desktop alerts use the browser's notification permission. Mobile delivery is not implemented.

### 3. Automatic Error Logging
The Extension may collect error messages to help improve functionality. Error data is stored locally on your device.

## What We Do NOT Collect

- We do NOT collect personal identification information like your name or email
- We do NOT track your browsing behavior outside of Canvas
- We do NOT send your data to third-party servers
- We do NOT use your data for advertising or marketing
- We do NOT share your data with other applications or services

## How Your Data Is Used

Your data is used exclusively to:
- Provide the enhanced Canvas interface
- Store and retrieve your preferences
- Calculate GPA and process assignment information
- Display reminders and notifications
- Improve the Extension's functionality

## Data Storage and Security

- All user data is stored locally on your device using Chrome's storage API
- The Extension does not maintain servers or databases
- Your data remains on your device and is not synced to external services (unless you enable Chrome sync, which is controlled by Google's Privacy Policy)
- Data is only accessible to the Canvas domain

## Permissions Used

The Extension requests the following permissions:

- **`storage`**: To save your preferences and settings locally
- **`content_scripts` on `https://*/*`**: To run on Canvas sites and enhance the interface
- **`background` service worker**: To handle extension operations

## Third-Party Services

This Extension does not integrate with third-party analytics, tracking, or data collection services. All functionality is local to your device.

## Canvas API Access

The Extension makes direct API calls to your Canvas instance to retrieve publicly available course information that you already have access to. This is done directly from your browser and not routed through any external servers.

## Your Rights

You have complete control over your data:
- You can view all stored preferences in the Extension's options page
- You can reset all settings at any time
- Uninstalling the Extension removes all associated data from your device
- Your Canvas data is managed by your educational institution, not by this Extension

## Changes to This Policy

We may update this Privacy Policy to reflect changes in our practices. We will notify users of significant changes through the Extension's release notes.

## Contact

For privacy concerns or questions about this Extension, please contact:
- **Email:** sandlerguy5@gmail.com
- **GitHub Issues:** [GuySandler/Actuallycanvasrefined](https://github.com/GuySandler/Actuallycanvasrefined)

## Compliance

This Extension operates in compliance with:
- Chrome Web Store Developer Program Policies
- GDPR (General Data Protection Regulation) - as no personal data is collected or transmitted
- FERPA (Family Educational Rights and Privacy Act) - as data handling is local to the user's device

---

By using Canvas Refined, you accept the terms of this Privacy Policy.
