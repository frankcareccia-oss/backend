PerkValet Enterprise Authorization Architecture



Version: 2.0 (Enterprise Reference Edition)

Status: Authoritative Governance \& Security Specification

Confidential – Internal Architecture Document



1\. Executive Overview



This document defines the complete Roles, Capabilities, and Scope architecture for the PerkValet platform. It governs authorization design across PV Org, Merchant, Store, Promotions, Billing, and Integration domains.



The objective is to provide a scalable, maintainable, and secure authorization model capable of supporting single-operator merchants through enterprise-scale deployments.



This specification supersedes all informal role-check logic and establishes capability-based authorization as the authoritative model.



2\. Architectural Principles



Roles are bundles of capabilities.



Capabilities are the only enforceable authorization unit.



Authorization must always be evaluated within scope.



Context separation is mandatory and non-negotiable.



UI must render based on capability availability, not role names.



Production safety rules must be enforced in middleware.



Capability keys are immutable identifiers once published.



3\. Context Separation Model



PerkValet operates in three distinct contexts:



PV Org (Global Governance) – /admin/\* – namespace pv\_\*



Merchant (Business Management) – /merchant/\* – namespace mr\_\*



Store (Operational Layer) – /store/\* – namespace st\_\*



Cross-context privilege leakage is strictly prohibited.



PV Org financial operations must not appear within Merchant UI.

Merchant payment logic must not appear within PV Org interfaces.



4\. Scope Hierarchy \& Evaluation



Scopes:



Global



Merchant (merchantId)



Store (storeId)



Rules:



Store scope implies merchant ownership but does not grant merchant-wide privileges.



Merchant scope does not automatically grant store-level operational control.



Scope must be explicitly passed in all authorization checks.



Authorization pattern:



can('invoice.issue', { global: true })

can('invoice.pay', { merchantId })

can('store.settings.edit', { storeId })

5\. Capability Taxonomy



Capabilities follow domain.verb\[.subverb] format.



Billing Domain



invoice.view



invoice.pay



invoice.issue



invoice.void



invoice.regenerate\_link



invoice.force\_state



Merchant Domain



merchant.profile.edit



merchant.user.invite



merchant.user.edit



merchant.user.remove



merchant.status.edit



Store Domain



store.view



store.settings.edit



store.staff.manage



store.device.manage



Promotions Domain



promo.create



promo.edit



promo.clone



promo.archive



promo.publish



promo.unpublish



promo.preview



promo.media.upload



promo.media.manage



promo.analytics.view



promo.redemption.export



promo.target.set



promo.rules.edit



Integration Domain



integration.square.catalog.read



integration.square.catalog.map



integration.square.images.import



Org Domain



org.team.view



org.team.manage



org.reporting.view



6\. Role Bundles (Reference Implementation)

pv\_admin



org.team.view



merchant.view



invoice.view



pv\_ar\_clerk



invoice.issue



invoice.void



invoice.regenerate\_link



mr\_owner



invoice.view



invoice.pay



merchant.user.invite



merchant.user.edit



merchant.user.remove



promo.publish



mr\_ap\_clerk



invoice.view



invoice.pay



mr\_marketing\_manager



promo.create



promo.publish



promo.analytics.view



st\_admin



store.settings.edit



store.staff.manage



7\. Multi-Store Merchant Scenarios



Scenario A:

Merchant owns 3 stores. A user has mr\_marketing\_manager at merchant scope and st\_admin at Store A only.

User can publish merchant-wide promotions but can edit settings only for Store A.



Scenario B:

Franchise environment. Regional manager granted promo.publish at merchant scope.

Store managers granted store.settings.edit at store scope only.



8\. Promotions Lifecycle Model



Promotions support lifecycle:



Draft → Published → Archived



Publishing requires promo.publish



Media upload requires promo.media.upload



Square SKU mapping requires integration.square.catalog.map



9\. One-Man Shop Simplification Model



If a merchant has only one user with mr\_owner:



Role terminology remains hidden in UI.



Full capability access remains under the hood.



UI simplifies automatically.



When second user is added, team management UI becomes visible.



10\. Database Schema Reference (Target Architecture)



Future full capability implementation requires:



Capability (id, key, description)



Role (id, key, namespace)



RoleCapability (roleId, capabilityId)



UserRoleAssignment (userId, roleId, scopeType, scopeId)



11\. Middleware Enforcement Model



Authorization checks must occur in backend middleware.

UI restrictions alone are insufficient.

pv\_qa must be blocked in production at middleware level.



12\. Security Threat Considerations



Prevent privilege escalation through scope confusion.



Prevent capability bypass via direct API calls.



Log all capability-denied events.



Enforce strict separation of PV Org and Merchant APIs.



13\. Migration Strategy



Phase 0: Introduce can() helper mapping roles to capabilities in code.

Phase 1: Introduce Capability and RoleCapability tables.

Phase 2: Refactor route guards page-by-page.

Phase 3: Deprecate direct role checks.



26\. Implementation Status \& Roadmap Alignment (2026-02)

Current State



PerkValet is currently operating in Phase 0 (Transitional Capability Mapping).



Authorization is role-enum based in the database.



MerchantUser and StoreUser models assign scoped enum roles.



Backend route guards perform role checks.



Frontend renders based on role checks and session flags.



Capability tables are not yet implemented in Prisma.



The architecture document defines the target model.

The runtime implementation is currently transitional.



Phase 0 — Stabilization (Active Direction)



Objective:



Introduce a centralized can() capability evaluation layer in both backend and frontend while keeping the existing schema intact.



Actions:



Map enum roles → capability keys in code.



Replace direct role string comparisons with can(capability, scope).



Remove UI authorization flags (e.g., readOnly) used as shortcuts.



Maintain existing Prisma schema (no migrations).



Enforce capability checks in middleware.



This aligns behavior with the v2 architecture without schema disruption.



Phase X — Full Capability Model (Future Structural Upgrade)



Objective:



Implement the full database-backed capability model described in Section 10.



Requires:



Capability table



Role table



RoleCapability table



UserRoleAssignment table with scoped bindings



Migration strategy for enum roles



Middleware refactor to DB-backed capability evaluation



Frontend refactor to consume resolved capability sets



Enables:



Dynamic capability management



Franchise delegation models



Enterprise governance



Fine-grained permission control



Capability-level auditability



This phase is deferred until merchant and enterprise complexity requires it.

