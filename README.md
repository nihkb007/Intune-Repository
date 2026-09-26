# Intune Automation Repository

Enterprise-grade Microsoft Intune & Microsoft Graph automation scripts.

Author: Nick Butcher  
GitHub: https://github.com/nihkb007/Intune-Repository  

---

## About This Repository

This repository contains scalable, production-focused automation scripts designed to solve real-world Microsoft Intune and Microsoft Entra ID challenges.

The goal of this project is to provide:

- Reliable automation solutions
- Performance-optimized Microsoft Graph API usage
- Governance-driven device management tools
- Scalable enterprise-ready scripting examples
- Practical solutions for MSP and enterprise environments

All scripts are written with performance, logging, safety controls, and responsible production deployment in mind.

---

## Featured Script

### Intune Primary User Auto-Assignment & Shared Device Correction

Automatically manages the **Primary User** field in Microsoft Intune based on Microsoft Entra ID (Azure AD) sign-in activity.

---

## Key Features

- Automatically assigns Primary User for single-user devices  
- Automatically removes Primary User for shared devices  
- Clears stale ownership assignments  
- Detects multiple-user logins within a defined timeframe  
- **Supports user exclusion logic**:
  - Skip specific user accounts
  - Skip users based on partial username matching
  - Skip entire Azure AD groups
- Excluded users are ignored during ownership evaluation
- Optimized Microsoft Graph batching
- Configurable device processing limits
- Timestamped logging with automatic retention trimming
- Optional failure email notifications
- Report, Test, and Live execution modes
- Designed for scheduled automation (hourly or daily)

---

## Enhanced Ownership Logic

The script now includes intelligent exclusion handling to prevent service accounts, administrative identities, or exception users from incorrectly becoming Primary Users.

Behavior examples:

- If **two users** sign in and **one is excluded**, the remaining eligible user will be assigned as the Primary User.
- If **three users** sign in and **one is excluded**, the device will still be classified as **shared**, because multiple eligible users remain.
- If only excluded users sign in, no changes are made.

Excluded accounts are removed from consideration before device classification occurs.

This ensures accurate ownership determination while maintaining governance controls.

---

## Why This Matters

Primary User accuracy directly impacts:

- Intune reporting accuracy
- Compliance targeting
- Conditional Access insights
- Asset ownership tracking
- Windows Autopilot reporting
- License alignment
- Governance integrity

In large or fast-moving environments, ownership drift is inevitable.  
This automation continuously realigns ownership based on real user behavior.

---

## Windows 11 Theme: NEON NEXUS

A dark neon Windows 11 theme with 5 accent colors, 10 4K wallpapers, a custom accent palette, a lock screen image and a Windows Terminal color scheme. Install it with one double-click; uninstall restores your previous setup. It can also be deployed per user as an Intune Win32 app.

[Windows11-Theme/NeonNexus](Windows11-Theme/NeonNexus/README.md)

![NEON NEXUS](Windows11-Theme/NeonNexus/preview.jpg)

---

## Custom Script Development

Need something specific for your environment?

I offer custom Microsoft Intune and Microsoft Graph automation development, including:

- Tenant-wide reporting solutions
- Automation workflows
- Compliance & governance scripting
- Device lifecycle automation
- Microsoft Graph API integrations
- Performance optimization for large environments
- Scheduled automation solutions
- Azure Automation / Runbook conversions

If you are interested in custom scripting or automation work, open an issue or contact me through GitHub.

Donations are also accepted for custom script requests.

---

## Support This Project

If these scripts help you, consider supporting the project:

- ⭐ Star the repository
- 🍴 Fork and contribute
- 💬 Provide feedback
- ❤️ Donate to support continued development

### Donation Option

Cash App: `$nihkolasb`

Your support helps fund continued automation development and new releases.

---

## Requirements

- PowerShell 7.x
- Azure App Registration
- Microsoft Graph Application Permissions:
  - DeviceManagementManagedDevices.ReadWrite.All
  - AuditLog.Read.All
  - User.Read.All
- Admin consent granted

---

## Security & Design Philosophy

These scripts:

- Use application authentication (Client Credentials flow)
- Avoid delegated permissions
- Minimize API calls using batching strategies
- Support scalable enterprise automation
- Include logging and operational safety controls
- Are built for enterprise-grade environments

Designed for responsible and secure deployment.

---

## Roadmap

Planned additions:

- Additional Intune automation utilities
- Advanced reporting enhancements
- Multi-tenant support tooling
- Governance dashboards
- Performance analytics modules
- Expanded automation libraries

---

## License

This project is licensed under the MIT License.

See the LICENSE file for details.

---

## Author

Nick Butcher  
Intune Automation & Enterprise Endpoint Engineering  

GitHub: https://github.com/nihkb007/Intune-Repository  
Created: 2026
