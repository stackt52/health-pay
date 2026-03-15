# Health-Pay

A health payment management system built with Next.js and Firebase.

## Project Overview

**Health-Pay** is a web-based application designed to facilitate health-related payments, adjudications, and provider management. It leverages a modern tech stack to provide a scalable and efficient experience.

- **Frontend**: Next.js 15+, React 19, TypeScript, Tailwind CSS 4
- **Backend**: Firebase Cloud Functions (Express.js on Node.js 24), Firestore database
- **Hosting**: Firebase Hosting

## Getting Started

### Prerequisites

- Node.js (v24 or compatible)
- Firebase CLI (`npm install -g firebase-tools`)

### Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd health-pay
   ```
2. **Install dependencies**:
   ```bash
   # Install root dependencies
   npm install
   
   # Install backend dependencies
   cd functions && npm install && cd ..
   ```

### Running Locally

- **Frontend**: `npm run dev` (Starts Next.js development server)
- **Backend (Emulators)**: `cd functions && npm run serve` (Starts Firebase emulators)

## Project Structure

- `src/`: Next.js frontend source code (App Router).
- `public/`: Static assets and frontend entry point.
- `functions/`: Firebase Cloud Functions (Backend API).
- `firestore.rules`: Security rules for the database.
- `firebase.json`: Configuration for Firebase Hosting and Emulators.

## Deployment

Deploy the entire project using the Firebase CLI:
```bash
firebase deploy
```
For targeted deployments:
- `firebase deploy --only hosting` (Frontend only)
- `firebase deploy --only functions` (Backend only)

## Documentation

For more detailed onboarding instructions, refer to the README files in the following directories:
- [Backend (Functions) Onboarding](./functions/README.md)
- [Public Assets Onboarding](./public/README.md)

---
*Created by the Health-Pay Team.*
