# 💸 SplitEase — Expense Sharing Made Simple

A lightweight, full-stack Splitwise clone with group expense management, auto-categorization, graph visualizations, and debt simplification.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Open in browser
# http://localhost:3000
```

## Features

| Feature | Description |
|---------|-------------|
| 👥 **Groups** | Create groups, add members by email |
| 💰 **Expense Splitting** | Equal, exact amount, or percentage splits |
| 🤖 **Auto-Categorize** | Keyword engine auto-detects categories from descriptions |
| 📊 **Charts** | Category doughnut, monthly trends, group comparison |
| 🤝 **Settle Up** | Simplified debts — minimizes number of transactions |
| 📱 **Mobile-First** | Dark mode, glassmorphism, responsive bottom nav |
| 🔐 **Auth** | JWT-based registration and login |

## Tech Stack

- **Backend**: Node.js + Express + SQLite
- **Frontend**: Vanilla HTML/CSS/JS + Chart.js
- **Auth**: JWT + bcrypt
- **Database**: SQLite (zero-config, single file)

## Categories

Pre-seeded: 🍕 Food & Drink · 🚗 Transport · 🎬 Entertainment · 🛍️ Shopping · 💡 Utilities · 🏠 Rent · 💊 Health · ✈️ Travel · 📚 Education · 📦 Other

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/register` | POST | Create account |
| `/api/auth/login` | POST | Login |
| `/api/auth/me` | GET | Current user |
| `/api/groups` | GET/POST | List/create groups |
| `/api/groups/:id` | GET/DELETE | Group details/delete |
| `/api/groups/:id/members` | POST | Add member |
| `/api/expenses/group/:id` | GET/POST | List/add expenses |
| `/api/expenses/:id` | PUT/DELETE | Edit/delete expense |
| `/api/settlements/:id/balances` | GET | Simplified debts |
| `/api/settlements/:id/settle` | POST | Record settlement |
| `/api/analytics/dashboard` | GET | Balance overview |
| `/api/analytics/categories` | GET | Spending by category |
| `/api/analytics/spending` | GET | Monthly trends |

## Deployment

The app runs as a single Node.js process. Deploy to any platform that supports Node.js:

```bash
# Set environment variables
PORT=3000
JWT_SECRET=your-secure-secret

# Start
npm start
```
# SplitEase
