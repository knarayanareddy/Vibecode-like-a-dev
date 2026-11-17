/**
 * VitePress documentation site configuration for `vibecode-like-a-dev` (roadmap 4.3).
 * Build locally with `npx vitepress dev docs` (keeps core runtime at zero dependencies).
 */
export default {
  title: 'vibecode-like-a-dev',
  description: 'From one paragraph or an existing repo to an enforceable, sandbox-verified software specification.',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/GUIDE' },
      { text: 'CLI', link: '/CLI' },
      { text: 'Case Studies', link: '/CASE-STUDIES' },
      { text: 'Benchmarks', link: '/results/BENCHMARK-REPORT' },
      { text: 'Runtime', link: '/EXPERIMENTAL' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'User Guide', link: '/GUIDE' },
          { text: 'CLI Reference', link: '/CLI' },
          { text: 'Authoring Primitives & Overlays', link: '/AUTHORING' }
        ]
      },
      {
        text: 'Case Studies & Evidence',
        items: [
          { text: 'Production Case Studies', link: '/CASE-STUDIES' },
          { text: 'Benchmark Report (34 Tasks)', link: '/results/BENCHMARK-REPORT' },
          { text: '18-Idea Stress Test', link: '/STRESS-TEST' },
          { text: 'Comparative Study', link: '/COMPARATIVE-STUDY' },
          { text: 'Landscape & Research', link: '/LANDSCAPE' }
        ]
      },
      {
        text: 'Autonomous Runtime & Governance',
        items: [
          { text: 'Runtime & Sandbox Boundary', link: '/EXPERIMENTAL' },
          { text: 'ADR 0011: Sandboxed Execution', link: '/adr/0011-sandboxed-execution-and-autonomous-build' },
          { text: 'ADR 0012: Governed Delivery & Audit', link: '/adr/0012-governed-github-delivery-and-audit-chain' },
          { text: 'Operational Runbook', link: '/runbook' }
        ]
      },
      {
        text: 'Historical Archive',
        items: [{ text: 'Archived Plans & Audits', link: '/archive/README' }]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/knarayanareddy/Vibecode-like-a-dev' }
    ]
  }
};
