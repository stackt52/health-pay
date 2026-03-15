# Health-Pay Public Assets

This directory contains static assets for the **Health-Pay** web application.

## Directory Structure

- `index.html`: Main entry point for the static hosting. Firebase Hosting serves this file as a Single Page Application (SPA), rewriting all routes to it.
- `*.svg`: Iconography and branding assets (e.g., `globe.svg`, `next.svg`, `vercel.svg`).

## Asset Management

- **Images & Icons**: Add new images or icons here to make them accessible via the root URL path (e.g., `/my-image.png`).
- **Static Content**: Any file placed here will be deployed to Firebase Hosting and served publicly.

## Hosting Notes

The project uses Firebase Hosting to serve the frontend. The `firebase.json` configuration in the root directory defines how these assets are handled, including URL rewrites and headers.

---
*Part of the Health-Pay project.*
