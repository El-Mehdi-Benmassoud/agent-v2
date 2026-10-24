import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  render,
  Box,
  Text,
  useInput,
  useStdout,
  useFocus,
} from 'ink';
import { SessionManager } from '../core/session/SessionManager.js';
import { SessionStatus, MessageRole, ContentType, ModelProvider } from '../types/index.js';

interface AppProps {
  sessionManager: SessionManager;
  configManager?: { get: () => { workspace?: { name?: string }; model?: { provider?: ModelProvider | string; modelId?: string } } };
}

export const App: React.FC<AppProps> = ({ sessionManager, configManager }) => {
  const { write } = useStdout();
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.INITIALIZING);
  const [showHelp, setShowHelp] = useState(false);
  const session = sessionManager.getCurrentSession();

  // Focus management
  useFocus();

  // Handle input
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (input === '') {
        process.exit(0);
      }
      setInput('');
      return;
    }

    if (key.ctrl && inputChar === 'd') {
      process.exit(0);
    }

    if (key.return) {
      if (input.trim()) {
        handleSendMessage(input);
      }
      return;
    }

    if (key.upArrow) {
      return;
    }

    if (key.downArrow) {
      return;
    }

    if (key.pageUp) {
      return;
    }

    if (key.pageDown) {
      return;
    }

    if (key.tab) {
      setShowHelp(prev => !prev);
      return;
    }

    if (key.escape) {
      sessionManager.abort();
      return;
    }

    if (!key.ctrl && !key.meta && inputChar.length === 1) {
      setInput(prev => prev + inputChar);
    }

    if (key.backspace) {
      setInput(prev => prev.slice(0, -1));
    }
  });

  // Subscribe to session events
  useEffect(() => {
    const currentSession = sessionManager.getCurrentSession();
    if (!currentSession) return;

    const updateMessages = () => {
      setMessages(currentSession.messages);
    };

    updateMessages();

    const onMessageAdded = (payload: { message: any }) => {
      setMessages(prev => [...prev, payload.message]);
    };

    const onTurnStart = (payload: { turnNumber: number }) => {
      const s = sessionManager.getCurrentSession();
      if (s) setStatus(s.status);
    };

    const onTurnEnd = (payload: { turnNumber: number; result: any }) => {
      const s = sessionManager.getCurrentSession();
      if (s) setStatus(s.status);
      updateMessages();
    };

    const onStreamDelta = (payload: { delta: string }) => {
      setMessages(prev => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role === 'assistant') {
          const newContent = last.content.map((c: any) => {
            if (c.type === 'text') return { ...c, text: c.text + payload.delta };
            return c;
          });
          return [...prev.slice(0, -1), { ...last, content: newContent }];
        }
        return prev;
      });
    };

    const onThinking = (payload: { delta: string }) => {
      setMessages(prev => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role === 'assistant') {
          const newContent = last.content.map((c: any) => {
            if (c.type === 'thinking') return { ...c, thinking: (c.thinking ?? '') + payload.delta };
            return c;
          });
          return [...prev.slice(0, -1), { ...last, content: newContent }];
        }
        return prev;
      });
    };

    const onToolStart = (payload: { toolName: string; toolUseId: string; input: unknown }) => {
      // Tool events are reflected in the message history
    };

    const onToolComplete = (payload: { toolName: string; toolUseId: string; success: boolean; output?: unknown; error?: string }) => {
      // Tool events are reflected in the message history
    };

    const onError = (error: any) => {
      console.error('Error:', error);
    };

    const onApprovalRequested = (request: any) => {
      // Approval handled by CLI, not TUI
    };

    sessionManager.on('messageAdded', onMessageAdded);
    sessionManager.on('turnStart', onTurnStart);
    sessionManager.on('turnEnd', onTurnEnd);
    sessionManager.on('streamDelta', onStreamDelta);
    sessionManager.on('thinking', onThinking);
    sessionManager.on('toolStart', onToolStart);
    sessionManager.on('toolComplete', onToolComplete);
    sessionManager.on('error', onError);
    sessionManager.on('approvalRequested', onApprovalRequested);

    return () => {
      sessionManager.off('messageAdded', onMessageAdded);
      sessionManager.off('turnStart', onTurnStart);
      sessionManager.off('turnEnd', onTurnEnd);
      sessionManager.off('streamDelta', onStreamDelta);
      sessionManager.off('thinking', onThinking);
      sessionManager.off('toolStart', onToolStart);
      sessionManager.off('toolComplete', onToolComplete);
      sessionManager.off('error', onError);
      sessionManager.off('approvalRequested', onApprovalRequested);
    };
  }, [sessionManager]);

  const handleSendMessage = useCallback(async (text: string) => {
    setInput('');
    setStatus(SessionStatus.ACTIVE);
    try {
      await sessionManager.sendMessage(text, { stream: true });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }, [sessionManager]);

  const config = configManager?.get() ?? {
    workspace: { name: session?.config.workingDirectory.split('/').pop() ?? 'agent-v2' },
    model: session?.config.model ?? { provider: '', modelId: '' },
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{config.workspace?.name || session?.config.workingDirectory.split('/').pop() || 'agent-v2'}</Text>
          <Box flexDirection="row">
            <Text color={status === SessionStatus.ACTIVE ? 'green' : status === SessionStatus.WAITING_FOR_APPROVAL ? 'yellow' : 'gray'}>
              ● {status}
            </Text>
            <Text color="gray">
              {session ? ` $${session.totalCostUsd.toFixed(4)}` : ''}
            </Text>
            <Text color="gray">
              {session ? ` ${session.turnCount} turns` : ''}
            </Text>
            <Text color="gray">
              {` ${session?.config.model.provider}/${session?.config.model.modelId}`}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Messages Area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {messages.map((message, index) => (
          <MessageComponent key={`${index}-${message.timestamp.getTime()}`} message={message} />
        ))}
      </Box>

      {/* Help Bar */}
      {showHelp && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} paddingY={1} marginTop={1}>
          <Text bold>Keyboard Shortcuts:</Text>
          <Text>Enter - Send message | Ctrl+C - Clear/Exit | Ctrl+D - Exit | Tab - Toggle help | Esc - Abort</Text>
        </Box>
      )}

      {/* Input Area */}
      <Box borderStyle="single" borderColor="gray" paddingX={1} paddingY={0} marginTop={1}>
        <Box flexDirection="row" alignItems="center">
          <Text bold color="cyan">{' > '}</Text>
          <Text>{input}</Text>
          <Text color="gray">_</Text>
        </Box>
        {!showHelp && (
          <Text color="gray" dimColor>
            Press Tab for shortcuts | Type your message and press Enter
          </Text>
        )}
      </Box>
    </Box>
  );
};

const MessageComponent: React.FC<{ message: any }> = ({ message }) => {
  const roleColors = {
    [MessageRole.USER]: 'cyan',
    [MessageRole.ASSISTANT]: 'green',
    [MessageRole.TOOL]: 'yellow',
    [MessageRole.SYSTEM]: 'gray',
  };

  const roleLabels = {
    [MessageRole.USER]: 'You',
    [MessageRole.ASSISTANT]: 'Agent',
    [MessageRole.TOOL]: 'Tool',
    [MessageRole.SYSTEM]: 'System',
  };

  const color = (roleColors as Record<string, string>)[message.role] || 'white';
  const label = (roleLabels as Record<string, string>)[message.role] || message.role;

  return (
    <Box marginBottom={1}>
      <Box flexDirection="row" marginBottom={0}>
        <Text bold color={color}>{label}:</Text>
        <Text color="gray">
          {` ${message.timestamp.toLocaleTimeString()}`}
        </Text>
      </Box>
      <MessageContent content={message.content} indent={2} />
      {message.metadata?.error ? (
        <Text color="red">Error: {String(message.metadata.error)}</Text>
      ) : null}
    </Box>
  );
};

const MessageContent: React.FC<{ content: any; indent?: number }> = ({ content, indent = 0 }) => {
  const indentStr = ' '.repeat(indent);

  if (typeof content === 'string') {
    return <Text>{indentStr}{content}</Text>;
  }

  if (Array.isArray(content)) {
    return (
      <Box flexDirection="column">
        {content.map((item, index) => (
          <MessageContentItem key={index} item={item} indent={indent} />
        ))}
      </Box>
    );
  }

  return <Text>{indentStr}{JSON.stringify(content)}</Text>;
};

const MessageContentItem: React.FC<{ item: any; indent?: number }> = ({ item, indent = 0 }) => {
  const indentStr = ' '.repeat(indent);

  if (typeof item === 'string') {
    return <Text>{indentStr}{item}</Text>;
  }

  switch (item.type) {
    case ContentType.TEXT:
      return <Text>{indentStr}{item.text}</Text>;

    case ContentType.TOOL_USE:
      return (
        <Box flexDirection="column">
          <Text color="yellow">{indentStr}🔧 Tool: {item.name}</Text>
          <Text color="gray">{indentStr}  Input: {JSON.stringify(item.input).slice(0, 200)}</Text>
        </Box>
      );

    case ContentType.TOOL_RESULT:
      return (
        <Box flexDirection="column">
          <Text color={item.isError ? 'red' : 'green'}>
            {indentStr}{item.isError ? '✗' : '✓'} Tool Result
          </Text>
          <Text color="gray">
            {indentStr}  {JSON.stringify(item.content).slice(0, 300)}
          </Text>
        </Box>
      );

    case ContentType.THINKING:
      return (
        <Text color="magenta" dimColor>
          {indentStr}💭 {item.thinking.slice(0, 300)}...
        </Text>
      );

    case ContentType.IMAGE:
      return (
        <Text color="blue">
          {indentStr}🖼️ Image: {item.source.type}
        </Text>
      );

    default:
      return <Text>{indentStr}{JSON.stringify(item)}</Text>;
  }
};

export default App;