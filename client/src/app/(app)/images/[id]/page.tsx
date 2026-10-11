'use client';

import { useParams } from 'next/navigation';
import { ImageDetailView } from '@/views';

/** `/images/[id]` — one image: what is wrong with it, and everywhere it runs. */
export default function ImageDetailPage() {
    const { id } = useParams<{ id: string }>();
    return <ImageDetailView imageId={id} />;
}
