# CareFlow AI - Agent-Based Healthcare Scheduling System

CareFlow AI is an agent-based healthcare appointment scheduling
application. It combines a React/Vite frontend with a FastAPI backend
and a LangGraph workflow to guide users through appointment scheduling,
collect missing details across turns, and return structured responses.


## Contents

-   [Overview](#overview)
-   [Features](#features)
-   [Technology Stack](#technology-stack)
-   [Architecture](#architecture)
-   [Project Structure](#project-structure)
-   [Prerequisites](#prerequisites)
-   [Configuration](#configuration)
-   [Run Locally](#run-locally)
-   [Run with Docker Compose](#run-with-docker-compose)
-   [API Overview](#api-overview)
-   [Doctor Directory Management](#doctor-directory-management)
-   [Deploy to Render](#deploy-to-render)
-   [Testing](#testing)
-   [Troubleshooting](#troubleshooting)
-   [Security and Data Notes](#security-and-data-notes)

## Overview

CareFlow AI uses a conversational workflow to collect appointment
details progressively. The scheduling agent maintains a conversation
thread, identifies the current scheduling step, asks for missing
information, and uses doctor and availability data to guide the flow.

The backend exposes HTTP endpoints for the frontend and initializes the
database when the application starts.

CareFlow AI is a portfolio and development project. It should not be
treated as a production clinical system without appropriate security,
privacy, reliability, and operational reviews.

## Features

### Conversational appointment scheduling

-   Chat-style scheduling requests.
-   Multi-turn conversations using a `thread_id`.
-   Progressive collection of missing appointment details, such as
    doctor or specialty, date, and time.
-   Structured responses containing the conversation ID, response text,
    status, and execution trace.
-   Conversation-state retrieval.

### Agent workflow

-   LangGraph orchestration.
-   LangChain tools for scheduling operations.
-   Workflow state managed through a checkpointing mechanism.
-   Separation between API handling, graph execution, and database
    operations.

### Doctor directory and administration

-   Doctor directory backed by the database.
-   JSON file validation and preview before import.
-   Import of validated doctor records.
-   Administrative functionality in the frontend for managing the
    directory.

### Application operations

-   FastAPI backend and health endpoint.
-   React/Vite frontend.
-   SQLite database for local development.
-   Docker Compose for running frontend and backend together.
-   CORS configuration for the frontend origin.

## Technology Stack

  Layer                  Technologies
  ---------------------- --------------------------------------------
  Frontend               React, Vite, JavaScript, CSS
  Backend API            Python, FastAPI, Uvicorn, Pydantic
  Agent orchestration    LangGraph, LangChain
  Language model         Groq API, if configured in the application
  Database               SQLite, SQLAlchemy
  Workflow persistence   LangGraph SQLite checkpoint integration
  File import            JSON upload and validation
  Local deployment       Docker, Docker Compose
  Cloud deployment       Render
  Tests                  pytest

## Architecture

``` text
User
  |
  v
React + Vite frontend
  |
  | HTTPS / JSON
  v
FastAPI backend
  |
  +--> Doctor directory and database operations
  |
  +--> LangGraph scheduling workflow
          |
          +--> Collect missing appointment details
          +--> Check doctor / specialty and availability
          +--> Maintain conversation state
          +--> Return response and workflow trace
  |
  v
SQLite database and LangGraph checkpoint storage
```

The exact workflow and transitions are defined by the code in
`backend/app/graph.py` and related modules.

## Project Structure

High-level guide to the main directories; keep this section aligned with
the repository if files are renamed or moved.

``` text
Agent-Based-Scheduling-System-Healthcare-Operations/
├── backend/
│   ├── app/
│   │   ├── api.py
│   │   ├── database.py
│   │   ├── graph.py
│   │   ├── checkpointer.py
│   │   ├── doctor_import.py
│   │   └── ...
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── ...
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

## Prerequisites

-   Python 3.11 or a version supported by the backend dependencies.
-   Node.js and npm compatible with the frontend.
-   Git.
-   Docker Desktop for Docker Compose.
-   A Groq API key if the configured workflow calls Groq models.

## Configuration

Create a local `.env` file using `.env.example` as a reference. Never
commit `.env` or real credentials.

Common settings may include:

``` env
GROQ_API_KEY=replace_with_your_groq_api_key
FRONTEND_URL=http://localhost:5173
```

-   `GROQ_API_KEY`: API credential if required by the configured Groq
    integration.
-   `FRONTEND_URL`: exact origin allowed by the backend CORS middleware.
    Locally this is typically `http://localhost:5173`; on Render, use
    the deployed frontend URL including `https://`, without a trailing
    slash.

Verify variable names against the current source and `.env.example`; do
not add variables the application does not read. Do not put secrets in
frontend variables prefixed with `VITE_`, because these values are
exposed to browser code.

## Run Locally

### 1. Clone the repository

``` bash
git clone https://github.com/shaadclt/CareFlow-AI-Agent-Based-Healthcare-Scheduling-System
cd CareFlow-AI-Agent-Based-Healthcare-Scheduling-System
```


### 2. Install and run the backend

From the repository root, create and activate a virtual environment.

**Windows PowerShell**

``` powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
```

If the Dockerfile uses a different requirements file, install from the
same file referenced by `backend/Dockerfile`.

Start the backend from the repository root:

``` powershell
python -m uvicorn backend.app.api:app --reload --host 127.0.0.1 --port 8000
```

-   Backend: `http://127.0.0.1:8000`
-   Health check: `http://127.0.0.1:8000/health`
-   Interactive API documentation: `http://127.0.0.1:8000/docs`

### 3. Install and run the frontend

Open a second terminal:

``` powershell
cd frontend
npm install
```

For local Vite development, configure the API URL if your frontend reads
it from an environment variable:

``` env
VITE_API_URL=http://127.0.0.1:8000
```

Then start the frontend:

``` powershell
npm run dev
```

Open the URL printed by Vite, typically `http://localhost:5173`. Ensure
the frontend API URL and backend CORS origin match your local setup.

## Run with Docker Compose

Make sure Docker Desktop is running. From the repository root:

``` powershell
docker compose build
docker compose up -d
docker compose ps
```

View logs:

``` powershell
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend
```

Stop the services:

``` powershell
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to
remove named volumes. Check the actual host ports in
`docker-compose.yml` to find the frontend URL. The backend is normally
exposed on port `8000` if that port is published in Compose.

## API Overview

The API is implemented in `backend/app/api.py`. Use the running Swagger
documentation at `/docs` as the source of truth for routes and schemas.

  -------------------------------------------------------------------------------------
  Method                  Endpoint                              Purpose
  ----------------------- ------------------------------------- -----------------------
  `GET`                   `/`                                   Service status
                                                                information

  `GET`                   `/health`                             Health check

  `POST`                  `/api/v1/schedule`                    Submit a scheduling
                                                                message

  `GET`                   `/api/v1/conversations/{thread_id}`   Retrieve conversation
                                                                state

  `GET`                   Doctor directory endpoint(s)          Retrieve doctor records

  `POST`                  Doctor preview/import endpoint(s)     Validate and import a
                                                                JSON doctor file
  -------------------------------------------------------------------------------------

### Example scheduling request

``` json
{
  "query": "I would like to book an appointment",
  "thread_id": "demo-session-001"
}
```

Use the exact request schema displayed at `/docs` for the running
version. Continue a multi-turn conversation with the same `thread_id`.

## Doctor Directory Management

The admin workflow allows a JSON doctor file to be uploaded, validated,
previewed, and imported into the database.

1.  Prepare a JSON file that follows the schema expected by the
    application.
2.  Use the preview/validation step to inspect records and validation
    errors.
3.  Import only after reviewing the preview.
4.  Confirm the imported records appear in the doctor directory.

The accepted JSON schema and required fields are defined in
`backend/app/doctor_import.py`. Refer to that module rather than
assuming a schema.

## Deploy to Render

The recommended setup uses two Render services: a backend Docker Web
Service and a frontend Static Site.

### Backend: Docker Web Service

1.  Push the project to GitHub.
2.  In the [Render Dashboard](https://dashboard.render.com/), create a
    **New Web Service** and connect the repository.
3.  Select **Docker** as the runtime.
4.  Set the Dockerfile path to `backend/Dockerfile` if that matches the
    repository's current configuration.
5.  Set the health check path to `/health`.
6.  Add the backend environment variables required by the application,
    including the Groq API key and `FRONTEND_URL`.
7.  Deploy and copy the public backend URL assigned by Render.

### Frontend: Static Site

1.  Create a **New Static Site** from the same repository.
2.  Set the root directory to `frontend`.
3.  Build command: `npm install && npm run build`
4.  Publish directory: `dist`
5.  Add `VITE_API_URL` with the actual public backend URL, such as
    `https://<your-backend-service>.onrender.com`.
6.  Deploy and copy the public frontend URL.

The example URLs are placeholders; use the URLs Render actually assigns.

### Configure CORS

Set `FRONTEND_URL` in the backend service's Render environment to the
exact frontend origin, for example:

``` text
https://<your-frontend-service>.onrender.com
```

Do not include a trailing slash. The backend CORS middleware should
allow this origin and the required local development origins. Avoid
using `*` as the production origin, particularly when credentials are
enabled. Redeploy or restart the backend after changing environment
variables.

### Persistent database storage

SQLite writes to a local file. Render's ordinary filesystem is
ephemeral, so database files can be lost on restart or redeployment
unless persistent storage is configured.

Before relying on deployed records: - Configure persistent storage
mounted at the directory where the application writes the SQLite
database, after checking the path in `backend/app/database.py`; or -
Migrate to a managed database and update the database configuration.

If LangGraph checkpoint data is stored separately, make sure that path
is persistent too when conversation state must survive restarts. A local
Docker Compose volume does not automatically transfer to Render.

### Post-deployment checklist

-   [ ] Backend deployment completes successfully.
-   [ ] `https://<your-backend-service>.onrender.com/health` returns a
    healthy response.
-   [ ] Frontend loads over HTTPS.
-   [ ] `VITE_API_URL` points to the actual backend URL.
-   [ ] `FRONTEND_URL` matches the frontend origin exactly.
-   [ ] Doctor directory loads.
-   [ ] Multi-turn scheduling works using the same `thread_id`.
-   [ ] Admin access and doctor JSON preview/import work.
-   [ ] Database and checkpoint data persist after a restart/redeploy.
-   [ ] No secrets are committed to GitHub or exposed in frontend
    variables.

## Testing

Run the backend tests from the repository root:

``` powershell
python -m pytest backend/tests -v
```

Report results from the latest test run. Application startup or a
healthy Docker status does not, by itself, mean all tests pass.

Recommended manual checks: - Health endpoint. - Doctor lookup by name
and specialty. - Availability lookup. - Multi-turn conversation with a
stable `thread_id`. - Date/time follow-up and booking completion. -
Admin login and logout. - Invalid JSON preview and valid JSON import. -
Persistence after container restart.

## Troubleshooting

### Browser reports a CORS error

-   Check `FRONTEND_URL` on the backend service.
-   Match the exact frontend origin, including `https://`.
-   Check that `VITE_API_URL` points to the correct backend.
-   Redeploy after environment changes.

### Frontend cannot reach the backend

Confirm the backend is live, the API URL is correct, and the frontend
uses the expected API paths. Inspect the browser console and Render
backend logs.

### Data disappears after redeployment

Confirm that SQLite and checkpoint files use persistent storage, or
migrate to a persistent managed database. Local Docker volumes are not
automatically available on Render.

## Security and Data Notes

-   Never commit `.env` files, API keys, passwords, or private
    administrator credentials.
-   Do not put secrets in frontend variables prefixed with `VITE_`.
-   Restrict CORS to the intended frontend origin in production.
-   Protect administrative endpoints with appropriate authentication and
    authorization.
-   Validate uploaded JSON files and keep upload limits enabled.
-   Use synthetic/demo patient information during development and
    demonstrations.
-   Do not use this project for clinical decisions or real patient data
    without appropriate privacy, security, compliance, and reliability
    controls.

## Roadmap

Potential future improvements: - More comprehensive end-to-end tests. -
Stronger authentication, role-based authorization, and audit logging. -
Persistent managed database support. - Appointment conflict prevention
and concurrency handling. - Structured logging and observability. -
CI/CD and deployment checks. - Accessibility and responsive UI
improvements.

## Author

**Mohamed Shaad**

CareFlow AI - Agent-Based Scheduling System for Healthcare Operations.
