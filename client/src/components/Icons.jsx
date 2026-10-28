import React from "react";

function Icon({ size = 18, strokeWidth = 2, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MonitorIcon = props => (
  <Icon {...props}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>
);

export const LockIcon = props => (
  <Icon {...props}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>
);

export const ShieldIcon = props => (
  <Icon {...props}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></Icon>
);

export const PlusIcon = props => (
  <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>
);

export const EnterIcon = props => (
  <Icon {...props}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5M15 12H3" /></Icon>
);

export const LogoutIcon = props => (
  <Icon {...props}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></Icon>
);

export const CopyIcon = props => (
  <Icon {...props}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Icon>
);

export const CheckIcon = props => (
  <Icon {...props}><path d="M5 12l5 5 9-10" /></Icon>
);

export const EyeIcon = props => (
  <Icon {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>
);

export const VolumeIcon = props => (
  <Icon {...props}><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12" /></Icon>
);

export const MuteIcon = props => (
  <Icon {...props}><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></Icon>
);

export const ExpandIcon = props => (
  <Icon {...props}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>
);

export const StopIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export const EyeOffIcon = props => (
  <Icon {...props}><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Icon>
);
