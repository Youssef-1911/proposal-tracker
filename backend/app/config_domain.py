"""
Fixed business configuration. Mirrors the frontend's src/domain/brands.js, routing.js,
roles.js, status.js and catalog.js; tests/test_config_parity.py fails if they drift.

Workflow rules that use it live in app/domain/.
"""

# ---------- Roles ----------

COMMERCIAL_HEAD = "commercial_head"
ACCOUNT_MANAGER = "account_manager"
BUSINESS_DEVELOPMENT = "business_development"

EXECUTIVE = "executive"
MARKETING = "marketing"
OPERATIONS = "operations"
HR = "hr"  # facilitators for events: staffing, the facilitator list, ratings (sees confirmed events only)
OFFICE_SCREEN = "office_screen"  # a read-only account for the office TV: sees the office screen and nothing else

ROLES = {
    COMMERCIAL_HEAD: "Commercial Head",
    ACCOUNT_MANAGER: "Account Manager",
    BUSINESS_DEVELOPMENT: "Business Development",
    EXECUTIVE: "Executive",
    MARKETING: "Marketing",
    OPERATIONS: "Operations",
    HR: "HR",
    OFFICE_SCREEN: "Office screen",
}
# In the order account screens list them (same as the frontend's ROLE_IDS).
ROLE_IDS = [BUSINESS_DEVELOPMENT, ACCOUNT_MANAGER, COMMERCIAL_HEAD, EXECUTIVE, MARKETING, OPERATIONS, HR, OFFICE_SCREEN]
# The roles that do the proposal work. Only these ever write status, stage, client or file
# history; the database CHECKs on those tables keep this list.
WORKING_ROLES = (COMMERCIAL_HEAD, ACCOUNT_MANAGER, BUSINESS_DEVELOPMENT)

# ---------- Privileges (per person; same as the frontend's domain/access.js) ----------

MANAGE_ACCOUNTS = "manageAccounts"
SEE_ANALYTICS = "seeAnalytics"
SEND_REMINDERS = "sendReminders"
SEE_ALL_BRANDS = "seeAllBrands"
BRINGS_IN_CLIENTS = "bringsInClients"
PRIVILEGE_IDS = [MANAGE_ACCOUNTS, SEE_ANALYTICS, SEND_REMINDERS, SEE_ALL_BRANDS, BRINGS_IN_CLIENTS]
PRIVILEGE_LABELS = {MANAGE_ACCOUNTS: "Manage accounts", SEE_ANALYTICS: "See analytics",
                    SEND_REMINDERS: "Send reminders", SEE_ALL_BRANDS: "See all brands",
                    BRINGS_IN_CLIENTS: "Brings in clients"}
_NONE = {p: False for p in PRIVILEGE_IDS}
ROLE_DEFAULT_PRIVILEGES = {
    # "Brings in clients" is turned on per person for the Head and Executives (Noha, Doaa), not by role.
    COMMERCIAL_HEAD: {**{p: True for p in PRIVILEGE_IDS}, BRINGS_IN_CLIENTS: False},
    EXECUTIVE: {**_NONE, SEE_ANALYTICS: True, SEND_REMINDERS: True, SEE_ALL_BRANDS: True},
    BUSINESS_DEVELOPMENT: {**_NONE, BRINGS_IN_CLIENTS: True},
    ACCOUNT_MANAGER: _NONE,
    MARKETING: _NONE,
    OPERATIONS: _NONE,
}

# ---------- Brands & services ----------

GRASSHOPPERS = "grasshoppers"
TEAM_UP = "teamup"

BRANDS = [
    {
        "id": GRASSHOPPERS,
        "name": "Grasshoppers",
        "services": [
            {"id": "school_trip", "label": "School trip"},
            {"id": "summer_camp", "label": "Summer camp"},
            {"id": "explorers_league", "label": "Explorers League"},
            {"id": "sleepover", "label": "Sleepover"},
            {"id": "kids_activity", "label": "Kids activity"},
            {"id": "activation", "label": "Activation"},
            {"id": "family_day", "label": "Family day"},
        ],
    },
    {
        "id": TEAM_UP,
        "name": "Team Up",
        "services": [
            {"id": "team_building", "label": "Team building"},
            {"id": "family_day", "label": "Family day"},
            {"id": "event_activation", "label": "Event activation"},
            {"id": "corporate_event", "label": "Corporate event"},
        ],
    },
]

BRAND_IDS = [b["id"] for b in BRANDS]
SERVICES_BY_BRAND = {b["id"]: [s["id"] for s in b["services"]] for b in BRANDS}

# The STARTING routing (which Account Manager receives each brand's requests). The live routing
# is the brand_routing table, changed in Settings; this seeds it (migration 0006, demo seed).
BRAND_AM_ROUTING = {
    GRASSHOPPERS: "u-mariam-elkhayat",
    TEAM_UP: "u-mariam-dimitri",
}

# ---------- Clients ----------

CLIENT_TYPES = {"school": "School", "corporate": "Corporate", "agency": "Agency", "other": "Other"}

# ---------- Statuses ----------
# Only the rule-relevant fields (labels included for display parity); UI tones stay in the frontend.

PROPOSAL_STATUSES = [
    {"id": "draft", "label": "Draft", "order": 1, "closed": False, "waitingOn": "bd", "deadlinePending": False,
     "stage": "draft", "subLabel": None},
    {"id": "submitted", "label": "Submitted", "order": 2, "closed": False, "waitingOn": "am", "deadlinePending": True,
     "stage": "with_am", "subLabel": "New"},
    {"id": "in_progress", "label": "In Progress", "order": 3, "closed": False, "waitingOn": "am", "deadlinePending": True,
     "stage": "with_am", "subLabel": "Preparing"},
    {"id": "awaiting_bd_info", "label": "Awaiting BD Information", "order": 4, "closed": False, "waitingOn": "bd", "deadlinePending": True,
     "stage": "with_am", "subLabel": "Needs BD info"},
    {"id": "ready_for_bd", "label": "Ready for BD", "order": 5, "closed": False, "waitingOn": "bd", "deadlinePending": False,
     "stage": "ready_to_send", "subLabel": "Proposal ready"},
    {"id": "shared_with_client", "label": "Shared with Client", "order": 6, "closed": False, "waitingOn": "bd", "deadlinePending": False,
     "stage": "with_client", "subLabel": "Awaiting reply"},
    {"id": "postponed", "label": "Postponed", "order": 7, "closed": False, "waitingOn": "bd", "deadlinePending": False,
     "stage": "with_client", "subLabel": "Postponed"},
    {"id": "revision_requested", "label": "Revision Requested", "order": 8, "closed": False, "waitingOn": "am", "deadlinePending": True,
     "stage": "with_am", "subLabel": "Revision (v{nextVersion})"},
    {"id": "accepted", "label": "Confirmed", "order": 9, "closed": True, "waitingOn": "none", "deadlinePending": False,
     "stage": "closed", "subLabel": "Confirmed"},
    {"id": "rejected", "label": "Rejected", "order": 10, "closed": True, "waitingOn": "none", "deadlinePending": False,
     "stage": "closed", "subLabel": "Lost"},
    {"id": "cancelled", "label": "Cancelled", "order": 11, "closed": True, "waitingOn": "none", "deadlinePending": False,
     "stage": "closed", "subLabel": "Cancelled"},
    # Earlier "closed history" statuses: no longer used (python -m app.apply_tracker_mapping moves them back); kept valid.
    {"id": "closed_unrecorded", "label": "Closed · outcome not recorded", "order": 12, "closed": True, "waitingOn": "none",
     "deadlinePending": False, "stage": "closed", "subLabel": "Outcome not recorded"},
    {"id": "closed_postponed", "label": "Closed · postponed", "order": 13, "closed": True, "waitingOn": "none",
     "deadlinePending": False, "stage": "closed", "subLabel": "Postponed (closed)"},
]

# Display stages (a presentation layer over the 11 statuses; same as the frontend STATUS_CONFIG.stage).
# "tone" is the badge colour; None = use the detailed status's tone (Won green, Lost red, Cancelled grey).
PROPOSAL_STAGES = [
    {"id": "draft", "label": "Draft", "order": 1, "tone": "neutral"},
    {"id": "with_am", "label": "With AM", "order": 2, "tone": "info"},
    {"id": "ready_to_send", "label": "Ready to send", "order": 3, "tone": "success"},
    {"id": "with_client", "label": "With client", "order": 4, "tone": "accent"},
    {"id": "closed", "label": "Closed", "order": 5, "tone": None},
]

# Fixed reasons for "Mark lost" (same as the frontend LOST_REASONS). A note is required for "other".
LOST_REASONS = [
    {"id": "price", "label": "Price"},
    {"id": "timing", "label": "Timing"},
    {"id": "competitor", "label": "Chose a competitor"},
    {"id": "no_response", "label": "No response"},
    {"id": "budget_cancelled", "label": "Budget cancelled"},
    {"id": "other", "label": "Other"},
    # Only for records imported from the 2026 tracker, which never recorded a reason. Never offered in a form.
    {"id": "not_recorded", "label": "Not recorded", "importOnly": True},
]
LOST_REASON_OTHER = "other"
LOST_REASON_NOT_RECORDED = "not_recorded"
LOST_REASON_IDS = [r["id"] for r in LOST_REASONS]
# The reasons a person can choose when marking something lost.
LOST_REASON_FORM_IDS = [r["id"] for r in LOST_REASONS if not r.get("importOnly")]

# How BD sent the proposal (recorded on the "Shared with Client" history entry; same as the frontend).
SHARE_CHANNELS = [
    {"id": "whatsapp", "label": "WhatsApp"},
    {"id": "email", "label": "Email"},
    {"id": "in_person", "label": "In person"},
    {"id": "other", "label": "Other"},
]
SHARE_CHANNEL_IDS = [c["id"] for c in SHARE_CHANNELS]

# ---------- Proposal files and comments (same as the frontend's domain/proposalFiles.js) ----------

PROPOSAL_FILE_TYPES = [
    {"id": "pdf", "extension": ".pdf", "label": "PDF"},
    {"id": "pptx", "extension": ".pptx", "label": "PowerPoint"},
]
PROPOSAL_FILE_TYPE_IDS = [t["id"] for t in PROPOSAL_FILE_TYPES]
PROPOSAL_FILE_MAX_BYTES = 25 * 1024 * 1024
# Files can be uploaded only while the request is with the AM (the With AM stage).
UPLOAD_STATUSES = ["submitted", "in_progress", "awaiting_bd_info", "revision_requested"]
COMMENT_MAX_LENGTH = 2000

OPPORTUNITY_STAGES = [
    {"id": "new_lead", "label": "New Lead", "order": 1, "closed": False, "outcome": None},
    {"id": "contacted", "label": "Contacted", "order": 2, "closed": False, "outcome": None},
    {"id": "requirements_gathered", "label": "Requirements Gathered", "order": 3, "closed": False, "outcome": None},
    {"id": "proposal_requested", "label": "Proposal Requested", "order": 4, "closed": False, "outcome": None},
    {"id": "negotiation", "label": "Negotiation", "order": 5, "closed": False, "outcome": None},
    {"id": "won", "label": "Confirmed", "order": 6, "closed": True, "outcome": "won"},
    {"id": "lost", "label": "Lost", "order": 7, "closed": True, "outcome": "lost"},
    {"id": "closed_no_result", "label": "Closed · no result", "order": 8, "closed": True, "outcome": None},
]

STAGE_IDS = [s["id"] for s in OPPORTUNITY_STAGES]
CLOSED_STAGES = {s["id"] for s in OPPORTUNITY_STAGES if s["closed"]}
LOST = "lost"
WON = "won"

EVENT_DATE_PRECISIONS = ("day", "month")  # opportunities
# A request may also say "Date not set yet" (no date).
REQUEST_EVENT_DATE_PRECISIONS = ("day", "month", "unset")
