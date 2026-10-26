# Suntek Dashboard — Clean Start (Admin only)

**Live URL:** https://suntek-86ae6.web.app  

Mock / demo transactional data has been wiped. Role ladder is live. **Only one login remains.**

---

## Login

| | |
|---|---|
| **Email** | `sagar@suntek.in` |
| **Password** | `Suntek@Aug2026` |
| **Role** | L0 · Admin |

Change the password after first login when you move toward real plant use.

---

## Management ladder (how the system is structured)

| Level | Meaning | Example roles in the app |
|---|---|---|
| **L0** | Admin | Owner · Admin *(Sagar — you)* |
| **L1** | Management | Management |
| **L2** | Unit Head | Unit Head |
| **L3** | Managers | Technical · Store · Purchase · Warehouse · Accounts |
| **L4** | Operators & Foremen | Operator · Foreman |

Sagar (L0) creates real people under User Management and assigns them L1–L4 roles. There are **no shared demo accounts** anymore.

---

## How to proceed (what you do next)

1. **Login** as Sagar on the live URL.  
2. **User Management** — add Unit Head, Store, Purchase, Technical, Operators / Foremen with their own emails + passwords.  
3. Walk each role through:
   - **Batch Sheet** — OCR upload / create sheet  
   - **Maintenance** — emergency → store indent  
   - **Store Req** — raise request → Unit Head approve  
4. When the plant is happy, treat this as UAT on demo DB, then cut over to production Supabase if needed.

---

## What was cleaned

Removed mock tickets, store stock rows, notifications, batches, and all logins except Sagar.  
**Kept:** plants, units, roles, tiers, and the Admin account.

---

## Known limits

- Batch OCR edge function may still need a redeploy if extraction times out.  
- Busy / complaints / polish items are later phases.
