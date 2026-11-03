# Frontend → backend test mapping (Phases 2, 3A, 3B, CRM 1 and accounts)

The frontend tests stay in place and keep running (`npm test`). Each test below is
ported 1:1 to pytest, with the frontend test name in the Python test's docstring.
Ported tests run through the **API** (SQL visibility + Python rules + JSON), not just the
Python functions.

On top of the 1:1 ports, `contracts/proposal-scenarios.json` (generated from the frontend
rules) is checked by **both** `frontend/tests/contracts.test.mjs` and
`backend/tests/test_contracts.py` (Python rules and the live API): 23 requests × 7 viewers
(allowed actions with reasons, visibility, editability, needs-my-action, versions,
deadline state) and 214 tracker queries (every role, scope, tab and sort, plus filter
cases, including Mariam El Khayat in both roles).

## `frontend/tests/tracker.test.mjs` → `backend/tests/test_tracker_port.py` (contract world, frozen clock)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | BD scopes: Mine = my requests + my drafts; Company = other owners' non-draft requests; no overlap | `test_bd_scopes_mine_and_company_do_not_overlap` | |
| 2 | AM scopes: My brand = my brand's non-draft requests; Company = the other brand only | `test_am_scopes_my_brand_and_other_brand_only` | |
| 3 | Mariam El Khayat follows her active role… | `test_mariam_follows_her_active_role` | + asserts BD scope is refused (422) while acting as AM |
| 4 | Head sees every non-draft request plus her own drafts, never another person's draft | `test_head_sees_every_non_draft_plus_own_drafts_only` | Uses the contract world's Noha draft instead of creating one (Phase 2 has no create endpoint) |
| 5 | private drafts cannot leak through search, filters, tab counts or empty states | `test_private_drafts_never_leak` | + 404 by ID |
| 6 | every row in every scope is viewable by its viewer | `test_every_row_in_every_scope_is_viewable` | Checked by fetching every row's detail (200) |
| 7 | search by request ID (partial, case-insensitive) and by client name | `test_search_by_id_and_client_name` | |
| 8 | each filter narrows correctly… | `test_each_filter_narrows_correctly` (7 cases) | |
| 9 | deadline-state filter uses the existing deadline rules | `test_deadline_state_filter_uses_existing_rules` | |
| 10 | combined filters intersect; clearing filters restores the full scope | `test_combined_filters_intersect_and_clearing_restores` | |
| 11 | tabs: Needs my action follows waitingOn + responsibility; Overdue; Closed | `test_tabs_needs_action_overdue_closed` | |
| 12 | default sort: active deadlines first… undated never invented | `test_default_sort_groups_and_undated_last` | Uses the contract world's undated draft |
| 13 | other sorts: last updated… event date… | `test_other_sorts` | |
| 14 | rows link to the detail page; own drafts open the editor when editable | `test_rows_say_whether_a_draft_opens_the_editor` | Server returns `canEditDraft`; building the link stays in the UI |
| 15 | Ready for BD and Shared with Client are shown distinctly | `test_ready_for_bd_and_shared_with_client_are_distinct` | The "Not yet shared" hint text stays in the UI |
| 16 | rows show waiting-on, month-only event dates…, missing dates as a dash | `test_rows_waiting_on_month_only_dates_and_missing_dates` | Server returns `YYYY-MM` / `null`; "Mar 2027" / "—" formatting stays in the UI |
| 17 | empty results are reported separately from an empty scope | `test_empty_results_are_distinct_from_an_empty_scope` | Server returns `scopeSize` |
| 18 | reads the existing dashboard links | `test_accepts_the_existing_dashboard_link_parameters` | |
| 19 | invalid or not-allowed URL values fall back to defaults; state round-trips through the URL | `test_invalid_values_are_rejected_with_422` (9 cases) | **Difference:** the API rejects invalid values (422). Silently falling back is URL-parsing behaviour that stays in the frontend. |

## `frontend/tests/proposals.test.mjs` → `backend/tests/test_proposals_port.py` (seeded demo database)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | requestedBy is gone; bdOwner is the client relationship owner | `test_requested_by_is_gone_and_bd_owner_is_the_client_owner` | |
| 2 | assignedAM always follows the brand routing rule | `test_assigned_am_always_follows_brand_routing` | |
| 3 | every request has createdBy and lastUpdated = latest history timestamp | `test_created_by_and_last_updated` | |
| 4 | history entries carry a valid role and version; current version matches history | `test_history_roles_and_versions` | |
| 5 | a request created by the Commercial Head on behalf of a BD keeps both people | `test_head_created_request_keeps_both_people` | + `submittedBy` |
| 6 | Mariam El Khayat's self-assigned requests record AM and BD steps in separate roles | `test_mariam_self_assigned_records_separate_roles` | |
| 7 | revised request keeps both versions; the unrecorded v1 price stays null | `test_revised_request_keeps_both_versions_and_never_invents_v1_price` | |
| 8 | no versions before the AM has started; a started version shows as pending | `test_no_versions_before_work_and_pending_version_without_price` | |
| 9 | only Ready for BD history entries carry a price | `test_only_ready_for_bd_entries_carry_a_price` | Also a database CHECK |
| 10 | every open/draft status has a nextStep; closed statuses have none | `test_open_statuses_wait_on_someone_and_closed_ones_do_not` | **Difference:** next-step wording is display text kept in the frontend; the server asserts the rule part (`waitingOn`) |
| 11 | responsible person follows waitingOn… | `test_responsible_person_follows_waiting_on` | |
| 12 | drafts are visible only to their creator (not even the Commercial Head)… | `test_drafts_visible_only_to_their_creator` | 404 for everyone else |
| 13 | a draft someone else created for a BD is not on that BD's dashboard | `test_draft_created_for_a_bd_by_someone_else_is_not_in_their_list` | Contract world (Noha's draft for Ahmed) |
| 14 | dashboard totals still reconcile after the field rename | `test_totals_reconcile` | 11 = 5 + 6 open; pipeline EGP 3,345,000 |
| 15 | timeline is newest first and marks exactly one origin entry | `test_history_is_ordered_with_a_single_origin` | Server returns oldest-first `seq 1..n`; the UI reverses it |
| 16 | event dates: month-only shows "Mar 2027", full dates show "14 Mar 2027" | `test_month_only_event_dates_are_kept_as_year_month` | Server returns `YYYY-MM`; wording is UI formatting |

## Phase 3A: action outcomes in the contract

`contracts/proposal-scenarios.json` now also holds **135 `actionCases`**.
- They cover every lifecycle action on every request:
  - each allowed performer with valid input;
  - invalid inputs;
  - a denied viewer;
  - a viewer who can't see the request (hidden draft);
  - an unknown action;
  - an action at the wrong status.
- Four scenarios add an extra request:
  - Mark won while another request is open (decision 2 warning);
  - Mark lost blocked by an open request;
  - Mark won reopening a Lost opportunity;
  - sharing on a Won opportunity.

Each case records the outcome: resulting status, stage, sub-label, version, price, deadline, submittedBy/At, the new history entry, the opportunity change with its reason code, warnings and message, or the failure code, message and field errors.

`frontend/tests/contracts.test.mjs` re-runs them through `applyAction`. `backend/tests/test_contract_actions.py` runs them through the Python `apply_action` and through the API, on a fresh copy of the world per case, and then reads back what was stored.

## `frontend/tests/workflow.test.mjs` → `backend/tests/test_workflow_port.py` (seeded demo database, write API)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | transition table only uses statuses from STATUS_CONFIG; cancel starts only from open statuses | `test_transition_table_and_cancel_from_open_statuses_only` | |
| 2 | end to end: create → submit → info loop → ready → share → revision v2 → ready → share → accepted | `test_end_to_end_lifecycle` | Also checks the opportunity history reason codes |
| 3 | AM steps: only the assigned AM, acting as AM | `test_am_steps_only_the_assigned_am_as_am` | 403 |
| 4 | BD steps: only the BD owner, acting as BD | `test_bd_steps_only_the_bd_owner_as_bd` | 403, exact text |
| 5 | Mariam El Khayat's actions follow her active role on her self-assigned requests | `test_mariam_actions_follow_her_active_role` | |
| 6 | getActions lists only actions for the current status, each with allowed/reason | `test_actions_for_the_current_status_with_allowed_and_reason` | `allowedActions` |
| 7 | actions not valid for the current status are rejected | `test_actions_not_valid_for_the_current_status_are_rejected` | 409; unknown action 422 |
| 8 | required inputs are validated and failures leave the record untouched | `test_required_inputs_are_validated_and_failures_change_nothing` | 422; row version and history unchanged |
| 9 | applyAction is pure: it never mutates the request it receives | `test_apply_action_is_pure_and_a_refused_action_changes_nothing` | Python `apply_action` on a frozen view |
| 10 | Commercial Head creates and submits on behalf of the BD owner; draft private until submitted | `test_head_creates_and_submits_on_behalf_draft_private_until_submitted` | 404 for the BD owner until submitted |
| 11 | a BD can create only for clients they own; an AM cannot create | `test_bd_creates_only_for_own_clients_and_am_cannot_create` | 403 / 422 |
| 12 | a BD submits their own draft; Mariam El Khayat must be in BD mode to submit hers | `test_bd_submits_own_draft_mariam_must_be_in_bd_mode` | |
| 13 | cancel: BD owner or Commercial Head with a reason; never the AM; never drafts or closed requests | `test_cancel_rules` | |
| 14 | rejected sets the opportunity Lost only when no other request for it is open | `test_rejected_sets_lost_only_when_no_other_request_is_open` | The other open request is created through the API |
| 15 | forward-only stage sync never moves an opportunity backward or reopens it | `test_forward_only_stage_sync` | Links an existing Ready request to the Won opportunity in the test database (the frontend adds a fake request) |
| 16 | dashboard metrics follow the shared record: submitting a draft adds one open request | `test_submitting_a_draft_adds_one_open_request` | Open count from the tracker list |
| 17 | turnaround still excludes time awaiting BD information after a live info loop | `test_turnaround_excludes_time_awaiting_bd_information` | **Difference:** steps run at a controlled server clock; the turnaround formula is applied to the stored history in the test (the dashboard metric itself is not ported yet) |
| 18 | denial reasons name who can act, e.g. BD owner or Commercial Head for cancel | `test_denial_reason_names_bd_owner_or_head_for_cancel` | |
| 19 | Mark lost needs a reason from the fixed list; a note is required only for "Other" | `test_mark_lost_needs_a_listed_reason_note_only_for_other` | |
| 20 | "Other" with a description is stored with its note | `test_other_with_a_description_is_stored_with_its_note` | |
| 21 | sharing records the channel from the fixed list | `test_sharing_records_the_channel` | |
| 22 | Mark won with other open requests: opportunity Won, the others untouched, and a warning lists them | `test_mark_won_with_other_open_requests_warns` | |
| 23 | opportunity reason codes: a Lost opportunity reopened by Mark won is recorded as reopened_after_acceptance | `test_mark_won_reopening_a_lost_opportunity_is_recorded` | |
| 24 | failures carry a code the API maps to an HTTP status | `test_failures_map_to_http_statuses` | 404 / 422 / 409 / 403 / 409 (no file yet) / 422 |
| 25 | Mark ready needs the current version's file; the reason shows in getActions | `test_proposal_files.py::test_mark_ready_needs_the_file_then_the_price` | Real upload through the API |
| 26 | from version 2, Mark ready also needs a "what changed" note | `test_proposal_files.py::test_version_2_needs_a_what_changed_note_and_old_versions_stay_downloadable` | |
| 27 | Mark lost when the opportunity is already Won: it stays Won, the reason stays on the request | `test_mark_lost_on_a_won_opportunity_keeps_it_won` | |

Tests that mark a request ready now upload a real file through the API first, the same way the frontend tests add a file.

## `frontend/tests/requestForm.test.mjs` → `backend/tests/test_request_form_port.py` (seeded demo database, write API)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | 1. a draft needs client, brand and service; a submission needs every request field | `test_1_draft_needs_client_brand_service_submission_needs_every_field` | |
| 2 | 2. invalid event dates, proposal deadlines and participant counts are rejected | `test_2_invalid_dates_deadlines_and_counts_are_rejected` | Python `validate_request_fields` plus an API check |
| 3 | 3. saving a draft creates a private Draft that is not in any AM queue | `test_3_saving_a_draft_creates_a_private_draft_not_in_any_am_queue` | Tracker scopes |
| 4 | 4. submitting creates the request and moves it to Submitted through the workflow | `test_4_submitting_creates_and_moves_to_submitted_through_the_workflow` | |
| 5 | 5. Grasshoppers requests route to Mariam El Khayat | `test_5_grasshoppers_routes_to_mariam_el_khayat` | |
| 6 | 6. Team Up requests route to Mariam Dimitri | `test_6_team_up_routes_to_mariam_dimitri` | |
| 7 | 7/8. Noha submits on behalf of the client owner; people stay separate | `test_7_8_noha_submits_on_behalf_people_stay_separate` | **Difference:** a `bdOwner` sent in the input is refused with 422 (the frontend silently ignores it) |
| 8 | 8. Mariam El Khayat's own Grasshoppers request | `test_8_mariam_own_request_one_person_bd_role_routed_to_her` | |
| 9 | 9. drafts are private to their creator | `test_9_drafts_private_to_creator` | 404 for reads and writes |
| 10 | 10. history: Draft then Submitted; editing adds no history; no resubmit | `test_10_history_draft_then_submitted_edit_adds_no_history_no_resubmit` | PATCH after submission → 409 |
| 11 | 11. saving and submitting the same draft never creates a second record | `test_11_saving_and_submitting_the_same_draft_never_creates_a_second_record` | |
| 12 | 11b. a failed submit saves nothing, and an existing draft keeps its last saved values | `test_11b_failed_submit_saves_nothing_draft_keeps_last_saved_values` | |
| 13 | 11c. possible duplicates are found among open requests only | `test_11c_possible_duplicates_among_open_requests_only` | Returned as a `possible_duplicate` warning |
| 14 | only BD (in BD role) and the Commercial Head can open the form | `test_only_bd_and_head_can_create_mariam_in_am_mode_is_told_to_switch` | |
| 15 | a BD sees and may use only their own clients; Noha sees all | `test_bd_uses_only_own_clients_noha_all` | 403 with `fields.clientId` |
| 16 | services must belong to the brand; a linked opportunity must be open and match | `test_services_belong_to_brand_and_opportunity_must_be_open_and_match` | |
| 17 | drafts are edited in place only by their creator in a creating role | `test_drafts_edited_in_place_only_by_creator_in_creating_role` | |
| 18 | month-only event dates are kept as month + year | `test_month_only_event_dates_are_kept_as_month_and_year` | Stored as the 1st, returned as `YYYY-MM` |
| 19 | 12. seeded drafts still submit and dashboards still reconcile | `test_12_seeded_drafts_still_submit_and_totals_reconcile` | |
| 20 | submitting an empty form reports every required field at once | `test_submitting_an_empty_form_reports_every_required_field` | |
| 21 | permission errors are not hidden by field errors when submitting | `test_permission_errors_are_not_hidden_by_field_errors` | 403 |

## `frontend/tests/proposalFiles.test.mjs` → `backend/tests/test_proposal_files.py` / `test_comments.py` (Phase 3B)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | only the assigned AM uploads, only while the request is with the AM; reasons name who can | `test_only_the_assigned_am_can_upload`, `test_upload_only_while_with_the_am_and_hidden_drafts_are_404` | 403 / 409 / 404 |
| 2 | uploading again replaces the version being prepared; a revision prepares the next version | `test_uploading_again_before_ready_replaces_the_file_and_keeps_its_history`, `test_version_2_needs_a_what_changed_note_and_old_versions_stay_downloadable` | |
| 3 | download names: request id, client name in safe characters, version | `test_downloads_for_every_viewer_as_attachment_with_a_safe_name` | |
| 4 | comments: plain text, trimmed, 1 to 2,000 characters | `test_comments.py::test_comment_validation`, `test_limits_and_trimming` | |
| 5 | price per participant is rounded to whole EGP and shown per version | `test_mark_ready_needs_the_file_then_the_price` | |
| 6 | stage timing: time in the current stage and since shared with the client | `test_counters_are_returned_with_every_request`, `test_sharing_records_the_version_and_channel` | |

These are checked on the server only and have no frontend counterpart: the real file type from its content, the 25 MB limit, random storage names, attachment-only downloads, orphan-file clean-up and append-only rows (`test_proposal_files.py`, `test_comments.py`).

The contract file also holds, for every request: upload eligibility per viewer, stage timing, price per participant, and the comment validation cases.

## `frontend/tests/crm.test.mjs` → `backend/tests/test_contract_crm.py` / `test_crm.py` (CRM 1)

| # | Frontend test | Python test | Notes |
|---|---|---|---|
| 1 | creating clients: any BD (as BD) or the Commercial Head; an AM cannot | `test_permissions_match_contract`, `test_crm.py` (Head and AM rules) | |
| 2 | editing a client: its owner (as BD) or the Head; others get the owner named; transfer is Head only | `test_permissions_match_contract`, `test_transfer_rules` | 403 with the same reason text |
| 3 | opportunities: owner or Head edit; Won is never a manual target and Won is final | `test_stage_moves_match_contract`, `test_crm.py` (manual Lost and Won) | |
| 4 | manual Lost needs a listed reason; reopening a Lost opportunity needs a note | `test_stage_moves_match_contract` | |
| 5 | field validation for clients, contacts and opportunities (no past dates on new or changed dates) | `test_field_validation_matches_contract` | |
| 6 | Egyptian phone formats and emails are compared normalised; similar names match | `test_duplicates_and_phones_match_contract` | A warning, never a block |
| 7 | transfer: reason required; open opportunities move; open requests move only when ticked | `test_transfer_plans_match_contract`, `test_transfer_moves_client_open_opportunities_and_open_requests`, `test_transfer_without_moving_requests` | |

Checked on the server only: one transaction per write (`test_transfer_is_one_transaction`), append-only `client_history` and `request_events`, server-set fields refused (422), stale writes (409), archived clients hidden, the transfer preview, and migration 0005 copying the old contact columns into `client_contacts` (and back on downgrade).

## Accounts, roles and privileges → `backend/tests/test_contract_accounts.py` / `test_accounts.py`

The frontend checks the contract file's `accountCases` in `contracts.test.mjs`; the backend checks the same cases
against the Python rules and the API (`/api/me` pages, scopes and privileges; `/api/analytics`; which clients and
opportunities each viewer gets). The contract's viewers now include an Executive, a Marketing and an Operations
person, and a Team Up AM with "See all brands"; every existing section (visibility, actions, tracker, CRM) runs for them.

Approved behaviour change: an Account Manager without "See all brands" no longer sees the other brand. Frontend and
backend tests that assumed the old Company tab for AMs now test both cases (hidden by default; visible but not
actionable with "See all brands").

Checked on the server only (`test_accounts.py`): creating Marketing/Operations people and their empty Home; Executives
see everything but every write is 403 (comments allowed); turning off "See analytics" (menu and 403); "See all brands";
the safeguards; deactivation warnings and history; stale edits (409); one transaction per change; append-only
`user_history` and `routing_history`; routing sending the next new request to the new AM. Migration 0006 is covered
by `test_migrations.py`.
