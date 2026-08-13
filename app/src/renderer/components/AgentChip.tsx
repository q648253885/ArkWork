interface AgentChipProps {
  agent: {
    name: string
    color?: string
  }
}

export function AgentChip({ agent }: AgentChipProps) {
  return (
    <span
      aria-label={`Agent：@${agent.name}`}
      className="inline-flex items-center justify-center h-[22px] min-w-[22px] px-2 rounded-md border text-2xs font-mono bg-bg-surface border-border-subtle text-text-secondary"
    >
      <span className="relative inline-flex items-center justify-center w-[22px] h-[22px] -m-2 mr-0">
        <span className="absolute w-1.5 h-1.5 rounded-full" style={{ backgroundColor: agent.color ?? 'var(--text-secondary)' }} />
      </span>
      @{agent.name}
    </span>
  )
}
