# Health-Pay Firebase Functions

This directory contains the backend logic for the **Health-Pay** platform, implemented as Firebase Cloud Functions using TypeScript and Express.

## Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Compile TypeScript**:
   ```bash
   npm run build
   ```
3. **Lint Code**:
   ```bash
   npm run lint
   ```

## Local Development & Emulators

To run the functions locally using the Firebase Emulator Suite:
```bash
npm run serve
```
This will build the code and start the emulator, making the API accessible at `localhost:5001`.

## Project Structure

- `src/index.ts`: Main entry point for Firebase Functions.
- `src/app.ts`: Express application setup and common middleware.
- `src/routes/`: API endpoint definitions (e.g., `providers.ts`).
- `src/engines/`: Business logic and state machine implementations (e.g., `adjudication.ts`, `anomaly.ts`).
- `src/__tests__/`: Unit and integration tests using Jest.

## Testing

Run the test suite:
```bash
npm test
```

## Deployment

Deploy functions to Firebase (requires Firebase CLI and authenticated session):
```bash
npm run deploy
```
*Note: Deployment is usually managed by CI/CD or triggered from the root directory via `firebase deploy --only functions`.*

---
*Part of the Health-Pay project.*
