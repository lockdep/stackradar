interface SpinnerProps {
    className?: string;
    size?: 'sm' | 'md' | 'lg';
}

const sizeMap = {
    sm: 'size-4',
    md: 'size-6',
    lg: 'size-8',
} as const;

export function Spinner({ className = '', size = 'md' }: SpinnerProps) {
    return (
        <svg
            className={`animate-spin-fast ${sizeMap[size]} ${className}`}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <circle className="opacity-10" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" />
            <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
    );
}
