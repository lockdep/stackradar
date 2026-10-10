export interface Member {
    id: string
    name: string | null
    email: string
    image: string | null
    role: 'owner' | 'admin' | 'member'
    joinedAt: string
}

export interface Invite {
    id: string
    email: string
    role: 'admin' | 'member'
    expiresAt: string
    createdAt: string
    inviteUrl: string
    invitedBy: {
        id: string
        name: string | null
        email: string
    }
}

export interface Usage {
    clusters: number
    uniqueImagesThisMonth: number
    members: number
    sbomsStored: number
}

export type PlanType = 'free' | 'pro' | 'team' | 'community'
