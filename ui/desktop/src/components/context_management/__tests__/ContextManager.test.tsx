import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ContextManagerProvider, useContextManager } from '../ContextManager';
import { Message } from '../../../types/message';
import * as contextManagement from '../index';

// Mock the context management functions
vi.mock('../index', () => ({
  manageContextFromBackend: vi.fn(),
  convertApiMessageToFrontendMessage: vi.fn(),
}));

const mockManageContextFromBackend = vi.mocked(contextManagement.manageContextFromBackend);
const mockConvertApiMessageToFrontendMessage = vi.mocked(
  contextManagement.convertApiMessageToFrontendMessage
);

describe('ContextManager', () => {
  const mockMessages: Message[] = [
    {
      id: '1',
      role: 'user',
      created: 1000,
      content: [{ type: 'text', text: 'Hello' }],
      display: true,
      sendToLLM: true,
    },
    {
      id: '2',
      role: 'assistant',
      created: 2000,
      content: [{ type: 'text', text: 'Hi there!' }],
      display: true,
      sendToLLM: true,
    },
  ];

  const mockSummaryMessage: Message = {
    id: 'summary-1',
    role: 'assistant',
    created: 3000,
    content: [{ type: 'text', text: 'This is a summary of the conversation.' }],
    display: false,
    sendToLLM: true,
  };

  const mockSetMessages = vi.fn();
  const mockAppend = vi.fn();
  const mockSetAncestorMessages = vi.fn();
  const mockClearAlerts = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderContextManager = () => {
    return renderHook(() => useContextManager(), {
      wrapper: ({ children }) => <ContextManagerProvider>{children}</ContextManagerProvider>,
    });
  };

  describe('Initial State', () => {
    it('should have correct initial state', () => {
      const { result } = renderContextManager();

      expect(result.current.isCompacting).toBe(false);
      expect(result.current.compactionError).toBe(null);
      expect(typeof result.current.handleAutoCompaction).toBe('function');
      expect(typeof result.current.handleManualCompaction).toBe('function');
      expect(typeof result.current.hasCompactionMarker).toBe('function');
    });
  });

  describe('hasCompactionMarker', () => {
    it('should return true for messages with summarizationRequested content', () => {
      const { result } = renderContextManager();
      const messageWithMarker: Message = {
        id: '1',
        role: 'assistant',
        created: 1000,
        content: [{ type: 'summarizationRequested', msg: 'Compaction marker' }],
        display: true,
        sendToLLM: false,
      };

      expect(result.current.hasCompactionMarker(messageWithMarker)).toBe(true);
    });

    it('should return false for messages without summarizationRequested content', () => {
      const { result } = renderContextManager();
      const regularMessage: Message = {
        id: '1',
        role: 'user',
        created: 1000,
        content: [{ type: 'text', text: 'Hello' }],
        display: true,
        sendToLLM: true,
      };

      expect(result.current.hasCompactionMarker(regularMessage)).toBe(false);
    });

    it('should return true for messages with mixed content including summarizationRequested', () => {
      const { result } = renderContextManager();
      const mixedMessage: Message = {
        id: '1',
        role: 'assistant',
        created: 1000,
        content: [
          { type: 'text', text: 'Some text' },
          { type: 'summarizationRequested', msg: 'Compaction marker' },
        ],
        display: true,
        sendToLLM: false,
      };

      expect(result.current.hasCompactionMarker(mixedMessage)).toBe(true);
    });
  });

  describe('handleAutoCompaction', () => {
    it('should successfully perform auto compaction', async () => {
      mockManageContextFromBackend.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Summary content' }],
          },
        ],
        tokenCounts: [100, 50],
      });

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockSummaryMessage);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleAutoCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockSetAncestorMessages
        );
      });

      expect(mockManageContextFromBackend).toHaveBeenCalledWith({
        messages: mockMessages,
        manageAction: 'summarize',
      });

      expect(mockSetAncestorMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: '1',
            display: true,
            sendToLLM: false,
          }),
          expect.objectContaining({
            id: '2',
            display: true,
            sendToLLM: false,
          }),
        ])
      );

      expect(mockSetMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            content: [{ type: 'summarizationRequested', msg: 'Conversation compacted and summarized' }],
          }),
          mockSummaryMessage,
          expect.objectContaining({
            content: [
              {
                type: 'text',
                text: expect.stringContaining('The above summary is provided for your context only'),
              },
            ],
          }),
        ])
      );

      // Fast-forward timers to trigger the append calls
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(mockAppend).toHaveBeenCalledTimes(2);
      expect(mockAppend).toHaveBeenCalledWith(mockSummaryMessage);
    });

    it('should handle compaction errors gracefully', async () => {
      const error = new Error('Backend error');
      mockManageContextFromBackend.mockRejectedValue(error);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleAutoCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockSetAncestorMessages
        );
      });

      expect(result.current.compactionError).toBe('Backend error');
      expect(result.current.isCompacting).toBe(false);

      expect(mockSetMessages).toHaveBeenCalledWith([
        ...mockMessages,
        expect.objectContaining({
          content: [
            {
              type: 'summarizationRequested',
              msg: 'Compaction failed. Please try again or start a new session.',
            },
          ],
        }),
      ]);
    });

    it('should set isCompacting state correctly during operation', async () => {
      let resolvePromise: (value: any) => void;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      mockManageContextFromBackend.mockReturnValue(promise as Promise<any>);

      const { result } = renderContextManager();

      // Start compaction
      act(() => {
        result.current.handleAutoCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockSetAncestorMessages
        );
      });

      // Should be compacting
      expect(result.current.isCompacting).toBe(true);
      expect(result.current.compactionError).toBe(null);

      // Resolve the backend call
      resolvePromise!({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Summary content' }],
          },
        ],
        tokenCounts: [100, 50],
      });

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockSummaryMessage);

      await act(async () => {
        await promise;
      });

      // Should no longer be compacting
      expect(result.current.isCompacting).toBe(false);
    });
  });

  describe('handleManualCompaction', () => {
    it('should clear alerts and perform compaction', async () => {
      mockManageContextFromBackend.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Manual summary content' }],
          },
        ],
        tokenCounts: [100, 50],
      });

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockSummaryMessage);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleManualCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockClearAlerts,
          mockSetAncestorMessages
        );
      });

      expect(mockClearAlerts).toHaveBeenCalledTimes(1);
      expect(mockManageContextFromBackend).toHaveBeenCalledWith({
        messages: mockMessages,
        manageAction: 'summarize',
      });
    });

    it('should work without clearAlerts function', async () => {
      mockManageContextFromBackend.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Manual summary content' }],
          },
        ],
        tokenCounts: [100, 50],
      });

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockSummaryMessage);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleManualCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          undefined, // No clearAlerts function
          mockSetAncestorMessages
        );
      });

      expect(mockManageContextFromBackend).toHaveBeenCalled();
      // Should not throw error when clearAlerts is undefined
    });

    it('should work without append function', async () => {
      mockManageContextFromBackend.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Manual summary content' }],
          },
        ],
        tokenCounts: [100, 50],
      });

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockSummaryMessage);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleManualCompaction(
          mockMessages,
          mockSetMessages,
          undefined, // No append function
          mockClearAlerts,
          mockSetAncestorMessages
        );
      });

      expect(mockManageContextFromBackend).toHaveBeenCalled();
      // Should not throw error when append is undefined
    });
  });

  describe('Error Handling', () => {
    it('should handle backend errors with unknown error type', async () => {
      mockManageContextFromBackend.mockRejectedValue('String error');

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleAutoCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockSetAncestorMessages
        );
      });

      expect(result.current.compactionError).toBe('Unknown error during compaction');
    });

    it('should handle missing summary content gracefully', async () => {
      mockManageContextFromBackend.mockResolvedValue({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'toolResponse', id: 'test', toolResult: { content: 'Not text content' } }],
          },
        ],
        tokenCounts: [100, 50],
      });

      const mockMessageWithoutText: Message = {
        id: 'summary-1',
        role: 'assistant',
        created: 3000,
        content: [{ type: 'toolResponse', id: 'test', toolResult: {} as any }],
        display: false,
        sendToLLM: true,
      };

      mockConvertApiMessageToFrontendMessage.mockReturnValue(mockMessageWithoutText);

      const { result } = renderContextManager();

      await act(async () => {
        await result.current.handleAutoCompaction(
          mockMessages,
          mockSetMessages,
          mockAppend,
          mockSetAncestorMessages
        );
      });

      // Should complete without error even if content is not text
      expect(result.current.isCompacting).toBe(false);
      expect(result.current.compactionError).toBe(null);
    });
  });

  describe('Context Provider Error', () => {
    it('should throw error when useContextManager is used outside provider', () => {
      expect(() => {
        renderHook(() => useContextManager());
      }).toThrow('useContextManager must be used within a ContextManagerProvider');
    });
  });
});
