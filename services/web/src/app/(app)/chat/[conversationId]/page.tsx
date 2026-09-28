import { ChatView } from '@/ui/chat/ChatView';

export default async function ChatPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return <ChatView id={conversationId} />;
}
