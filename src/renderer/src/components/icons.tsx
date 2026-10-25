import type { ReactNode } from 'react'

/**
 * 内联 SVG 图标集（零依赖）。
 * 统一 16×16 视口、stroke 继承 currentColor，供导航与操作按钮使用。
 */
function Svg({ children, size = 16 }: { children: ReactNode; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function IconChat({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" />
    </Svg>
  )
}

export function IconGrid({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  )
}

export function IconTasks({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.8-5.5" />
    </Svg>
  )
}

export function IconAgents({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M12 2.5l8 4.6v9.3l-8 4.6-8-4.6V7.1z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function IconRuns({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconSettings({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" fill="var(--panel)" />
      <circle cx="15" cy="12" r="2" fill="var(--panel)" />
      <circle cx="7" cy="17" r="2" fill="var(--panel)" />
    </Svg>
  )
}

export function IconPlus({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconTrash({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
    </Svg>
  )
}

export function IconSend({ size }: { size?: number }): ReactNode {
  return (
    <Svg size={size}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
    </Svg>
  )
}
