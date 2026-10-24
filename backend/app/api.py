from contextlib import asynccontextmanager
from typing import Any
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from time import perf_counter

from fastapi import (
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.app.database import SessionLocal, init_db
from backend.app.models import Appointment, Doctor, DoctorAvailability
from backend.app.graph import build_graph
from backend.app.doctor_import import (
    MAX_UPLOAD_BYTES,
    import_doctors,
    list_doctors,
    validate_doctors_json,
)
from backend.app.metrics_store import (
    init_metrics_db,
    record_http_metric,
    record_workflow_metric,
    get_metrics_summary,
)


# ============================================================
# Observability / Logging
# ============================================================

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(message)s",
)

logger = logging.getLogger("careflow")


def log_event(event: str, **fields: Any) -> None:
    """Write a structured JSON log without sensitive request content."""
    record = {
        "event": event,
        "timestamp": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ",
            time.gmtime(),
        ),
        **fields,
    }
    logger.info(json.dumps(record, default=str))


# ============================================================
# Admin authentication (stdlib-only signed bearer tokens)
# ============================================================

ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 8


class AdminLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=1024)


def _admin_secret() -> str:
    secret = os.getenv("ADMIN_SECRET_KEY", "")
    if len(secret) < 32:
        raise HTTPException(
            status_code=503,
            detail=(
                "Admin authentication is not configured securely. "
                "Set ADMIN_SECRET_KEY to a random value of at least "
                "32 characters."
            ),
        )
    return secret


def _encode_token(payload: dict[str, Any]) -> str:
    raw = json.dumps(
        payload,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()

    encoded = (
        base64.urlsafe_b64encode(raw)
        .rstrip(b"=")
        .decode()
    )

    signature = hmac.new(
        _admin_secret().encode(),
        encoded.encode(),
        hashlib.sha256,
    ).digest()

    signature_encoded = (
        base64.urlsafe_b64encode(signature)
        .rstrip(b"=")
        .decode()
    )

    return f"{encoded}.{signature_encoded}"


def _decode_token(token: str) -> dict[str, Any]:
    try:
        encoded, signature = token.split(".", 1)

        expected = hmac.new(
            _admin_secret().encode(),
            encoded.encode(),
            hashlib.sha256,
        ).digest()

        supplied = base64.urlsafe_b64decode(
            signature + "=" * (-len(signature) % 4)
        )

        if not hmac.compare_digest(expected, supplied):
            raise ValueError("Invalid signature")

        raw = base64.urlsafe_b64decode(
            encoded + "=" * (-len(encoded) % 4)
        )

        payload = json.loads(raw)

        if (
            payload.get("role") != "admin"
            or int(payload.get("exp", 0)) < int(time.time())
        ):
            raise ValueError("Expired or invalid token")

        return payload

    except Exception as exc:
        raise HTTPException(
            status_code=401,
            detail="Admin session is invalid or expired. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def require_admin(
    authorization: str | None = Header(default=None),
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Admin login is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return _decode_token(authorization[7:].strip())


# ============================================================
# Graph
# ============================================================

graph = build_graph()


# ============================================================
# Application Lifecycle
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize application resources on startup."""
    init_db()
    init_metrics_db()
    log_event("application_started")
    try:
        yield
    finally:
        log_event("application_stopped")


# ============================================================
# FastAPI Application
# ============================================================

app = FastAPI(
    title="Healthcare Agent Scheduling System",
    description=(
        "Agentic healthcare scheduling system built with "
        "LangChain, LangGraph, FastAPI and SQLite."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://careflow-frontend-j5mj.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# HTTP Request Observability Middleware
# ============================================================

@app.middleware("http")
async def log_http_requests(
    request: Request,
    call_next,
):
    """Measure API latency and log the HTTP outcome."""
    start_time = perf_counter()
    status_code = 500

    try:
        response = await call_next(request)
        status_code = response.status_code
        return response

    except Exception:
        log_event(
            "http_request_exception",
            method=request.method,
            path=request.url.path,
        )
        logger.exception("Unhandled HTTP request exception")
        raise

    finally:
        duration_ms = round(
            (perf_counter() - start_time) * 1000,
            2,
        )

        outcome = "success" if status_code < 400 else "failure"
        # Use the matched route template when available; avoid storing query
        # strings or user-provided identifiers in persistent metrics.
        route = request.scope.get("route")
        route_path = getattr(route, "path", request.url.path)

        log_event(
            "http_request",
            method=request.method,
            path=route_path,
            status_code=status_code,
            duration_ms=duration_ms,
            outcome=outcome,
        )

        try:
            record_http_metric(
                method=request.method,
                path=route_path,
                status_code=status_code,
                duration_ms=duration_ms,
                outcome=outcome,
            )
        except Exception:
            # Observability must never break a user-facing request.
            logger.exception("Unable to persist HTTP observability metric")


# ============================================================
# Request Schemas
# ============================================================

class SchedulingRequest(BaseModel):
    """User message sent to the scheduling agent."""

    query: str = Field(
        ...,
        min_length=1,
        description="User's scheduling request.",
        examples=[
            "I want an appointment with Dr. Michael Brown"
        ],
    )

    thread_id: str = Field(
        default="default",
        min_length=1,
        description="Conversation identifier.",
        examples=["patient-001"],
    )


# ============================================================
# Response Schemas
# ============================================================

class SchedulingResponse(BaseModel):
    """Response returned by the scheduling agent."""

    thread_id: str
    response: str
    status: str
    trace: list[dict[str, Any]] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class ConversationStateResponse(BaseModel):
    thread_id: str
    status: str = ""
    intent: str = ""
    patient_name: str = ""
    doctor_name: str = ""
    specialty: str = ""
    appointment_date: str = ""
    appointment_time: str = ""
    available_slots: list[str] = Field(default_factory=list)


# ============================================================
# Root and Health Check
# ============================================================

@app.get("/", response_model=HealthResponse)
async def root():
    return {
        "status": "ok",
        "service": "Healthcare Agent Scheduling System",
        "version": "1.0.0",
    }


@app.get("/health", response_model=HealthResponse)
async def health():
    return {
        "status": "healthy",
        "service": "Healthcare Agent Scheduling System",
        "version": "1.0.0",
    }


# ============================================================
# Schedule Appointment + Workflow Observability
# ============================================================

@app.post(
    "/api/v1/schedule",
    response_model=SchedulingResponse,
)
async def schedule(request: SchedulingRequest):
    start_time = perf_counter()

    try:
        config = {
            "configurable": {
                "thread_id": request.thread_id,
            }
        }

        result = graph.invoke(
            {"query": request.query},
            config=config,
        )

        status = str(result.get("status", ""))
        trace = result.get("trace", [])

        if not isinstance(trace, list):
            trace = []

        duration_ms = round(
            (perf_counter() - start_time) * 1000,
            2,
        )

        executed_nodes = [
            item.get("node", "unknown")
            for item in trace
            if isinstance(item, dict)
        ]

        # This label is based on the graph's returned status.
        # Verify "booking_completed" against graph.py.
        outcome = (
            "booking_completed"
            if status == "booking_completed"
            else "incomplete_or_other"
        )

        log_event(
            "scheduling_workflow",
            outcome=outcome,
            workflow_status=status,
            duration_ms=duration_ms,
            trace_node_count=len(trace),
            executed_nodes=executed_nodes,
        )
        try:
            record_workflow_metric(
                workflow_status=status or "unknown",
                outcome=outcome,
                duration_ms=duration_ms,
                trace_node_count=len(trace),
            )
        except Exception:
            logger.exception("Unable to persist workflow observability metric")

        return SchedulingResponse(
            thread_id=request.thread_id,
            response=result.get("response", ""),
            status=status,
            trace=trace,
        )

    except HTTPException:
        raise

    except Exception:
        duration_ms = round(
            (perf_counter() - start_time) * 1000,
            2,
        )

        log_event(
            "scheduling_workflow_failed",
            duration_ms=duration_ms,
        )
        try:
            record_workflow_metric(
                workflow_status="error",
                outcome="failure",
                duration_ms=duration_ms,
                trace_node_count=0,
            )
        except Exception:
            logger.exception("Unable to persist failed workflow metric")
        logger.exception("Scheduling workflow failed")

        raise HTTPException(
            status_code=500,
            detail=(
                "An error occurred while processing "
                "the scheduling request."
            ),
        ) from None


# ============================================================
# Conversation State
# ============================================================

@app.get(
    "/api/v1/conversations/{thread_id}",
    response_model=ConversationStateResponse,
)
async def get_conversation_state(thread_id: str):
    try:
        config = {
            "configurable": {
                "thread_id": thread_id,
            }
        }

        state_snapshot = graph.get_state(config)
        values = state_snapshot.values

        return ConversationStateResponse(
            thread_id=thread_id,
            status=values.get("status", ""),
            intent=values.get("intent", ""),
            patient_name=values.get("patient_name", ""),
            doctor_name=values.get("doctor_name", ""),
            specialty=values.get("specialty", ""),
            appointment_date=values.get("appointment_date", ""),
            appointment_time=values.get("appointment_time", ""),
            available_slots=values.get("available_slots", []),
        )

    except Exception:
        logger.exception("Unable to retrieve conversation state")
        raise HTTPException(
            status_code=500,
            detail="Unable to retrieve conversation state.",
        ) from None


# ============================================================
# Debug Conversation (Admin Only)
# ============================================================

@app.get("/api/v1/conversations/{thread_id}/debug")
async def debug_conversation(
    thread_id: str,
    admin=Depends(require_admin),
):
    """Return full graph state only to authenticated administrators."""
    try:
        config = {
            "configurable": {
                "thread_id": thread_id,
            }
        }

        snapshot = graph.get_state(config)

        log_event("conversation_debug_access")

        return {
            "thread_id": thread_id,
            "state": snapshot.values,
        }

    except HTTPException:
        raise

    except Exception:
        logger.exception("Unable to retrieve conversation debug state")
        raise HTTPException(
            status_code=500,
            detail="Unable to retrieve conversation debug state.",
        ) from None


# ============================================================
# Admin Login
# ============================================================

@app.post("/api/v1/admin/login")
async def admin_login(request: AdminLoginRequest):
    username = os.getenv("ADMIN_USERNAME", "")
    password = os.getenv("ADMIN_PASSWORD", "")

    if not username or not password:
        raise HTTPException(
            status_code=503,
            detail=(
                "Admin credentials are not configured. "
                "Set ADMIN_USERNAME and ADMIN_PASSWORD "
                "in the backend environment."
            ),
        )

    username_ok = secrets.compare_digest(
        request.username,
        username,
    )
    password_ok = secrets.compare_digest(
        request.password,
        password,
    )

    if not (username_ok and password_ok):
        log_event("admin_login_failed")
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password.",
        )

    now = int(time.time())

    token = _encode_token(
        {
            "sub": username,
            "role": "admin",
            "iat": now,
            "exp": now + ADMIN_TOKEN_TTL_SECONDS,
        }
    )

    log_event("admin_login_succeeded")

    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": ADMIN_TOKEN_TTL_SECONDS,
    }


@app.get("/api/v1/admin/session")
async def admin_session(admin=Depends(require_admin)):
    return {
        "authenticated": True,
        "username": admin.get("sub", "admin"),
    }


# ============================================================
# Admin: Observability Dashboard Data
# ============================================================

@app.get("/api/v1/admin/observability")
async def admin_observability(admin=Depends(require_admin)):
    """Return persisted request and scheduling workflow metrics."""
    try:
        return get_metrics_summary()
    except Exception:
        logger.exception("Unable to load observability metrics")
        raise HTTPException(
            status_code=500,
            detail="Unable to load observability metrics.",
        ) from None


# ============================================================
# Admin: Doctor JSON Validation
# ============================================================

async def _read_and_validate_doctor_file(
    file: UploadFile,
) -> dict[str, Any]:
    """Read and validate an uploaded doctor JSON file."""

    if (
        not file.filename
        or not file.filename.lower().endswith(".json")
    ):
        raise HTTPException(
            status_code=400,
            detail="Please upload a .json file.",
        )

    try:
        raw = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()

    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail="The upload exceeds the 2 MB limit.",
        )

    result = validate_doctors_json(raw)

    if not result["valid"]:
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    "The doctor JSON file contains validation errors."
                ),
                "errors": result["errors"],
            },
        )

    return result


# ============================================================
# Admin: Preview Doctor Import
# ============================================================

@app.post("/api/v1/admin/doctors/preview")
async def preview_doctors(
    file: UploadFile = File(...),
    admin=Depends(require_admin),
):
    result = await _read_and_validate_doctor_file(file)
    doctors = result["doctors"]

    specialties = sorted(
        {doctor["specialty"] for doctor in doctors}
    )

    log_event(
        "doctor_import_preview",
        doctor_count=len(doctors),
        specialty_count=len(specialties),
    )

    return {
        "valid": True,
        "total_doctors": len(doctors),
        "total_specialties": len(specialties),
        "specialties": specialties,
        "doctors": doctors[:100],
        "preview_truncated": len(doctors) > 100,
        "errors": [],
    }


# ============================================================
# Admin: Initialize Doctor Directory
# ============================================================

@app.post("/api/v1/admin/doctors/initialize")
async def initialize_doctors(
    file: UploadFile = File(...),
    admin=Depends(require_admin),
):
    result = await _read_and_validate_doctor_file(file)

    try:
        import_result = import_doctors(result["doctors"])
        current_doctors = list_doctors()

    except Exception:
        logger.exception("Doctor directory import failed")
        raise HTTPException(
            status_code=500,
            detail=(
                "Doctor import failed. "
                "The database transaction was rolled back."
            ),
        ) from None

    specialties = {
        doctor["specialty"]
        for doctor in current_doctors
        if doctor.get("specialty")
    }

    log_event(
        "doctor_directory_initialized",
        total_doctors=len(current_doctors),
        total_specialties=len(specialties),
    )

    return {
        "message": "Doctor directory initialized successfully.",
        **import_result,
        "total_doctors": len(current_doctors),
        "total_specialties": len(specialties),
    }


# ============================================================
# Admin: List Doctors
# ============================================================

@app.get("/api/v1/admin/doctors")
async def get_doctors(admin=Depends(require_admin)):
    doctors = list_doctors()

    return {
        "doctors": doctors,
        "total_doctors": len(doctors),
    }


# ============================================================
# Admin: Doctor Summary
# ============================================================

@app.get("/api/v1/admin/doctors/summary")
async def get_doctor_summary(admin=Depends(require_admin)):
    doctors = list_doctors()

    specialties = {
        doctor["specialty"]
        for doctor in doctors
        if doctor.get("specialty")
    }

    return {
        "total_doctors": len(doctors),
        "total_specialties": len(specialties),
    }


# ============================================================
# Admin: Reset Doctor Directory
# ============================================================

@app.post("/api/v1/admin/doctors/reset")
async def reset_doctor_directory(admin=Depends(require_admin)):
    """Delete doctors, availability and linked appointments.

    This destructive operation is restricted to authenticated admins.
    Patient records are retained.
    """
    db = SessionLocal()

    try:
        appointments_deleted = db.query(Appointment).delete(
            synchronize_session=False
        )

        availability_deleted = db.query(
            DoctorAvailability
        ).delete(
            synchronize_session=False
        )

        doctors_deleted = db.query(Doctor).delete(
            synchronize_session=False
        )

        db.commit()

        log_event(
            "doctor_directory_reset",
            doctors_deleted=doctors_deleted,
            availability_slots_deleted=availability_deleted,
            appointments_deleted=appointments_deleted,
        )

        return {
            "message": "Doctor directory reset successfully.",
            "doctors_deleted": doctors_deleted,
            "availability_slots_deleted": availability_deleted,
            "appointments_deleted": appointments_deleted,
        }

    except Exception:
        db.rollback()
        logger.exception("Doctor directory reset failed")

        raise HTTPException(
            status_code=500,
            detail=(
                "Could not reset the doctor directory. "
                "No changes were committed."
            ),
        ) from None

    finally:
        db.close()
