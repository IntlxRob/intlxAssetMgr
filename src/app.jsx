import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { 
  setProxy, 
  getAssetsByUserId, 
  getAssetById, 
  updateAsset, 
  getUser, 
  getOrganization, 
  apiErrorToText 
} from './api';

const BACKEND_BASE_URL = "https://intlxassetmgr-proxy.onrender.com";

// Simple OnCall Badge Component for Header
function OnCallBadge() {
  const [oncallAgent, setOncallAgent] = useState(null);
  const [oncallLoading, setOncallLoading] = useState(false);

  useEffect(() => {
    fetchOncallAgent();
    const interval = setInterval(fetchOncallAgent, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  async function fetchOncallAgent() {
    setOncallLoading(true);
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/pagerduty-oncall`);
      if (response.ok) {
        const data = await response.json();
        setOncallAgent(data.oncall);
      } else {
        setOncallAgent(null);
      }
    } catch (err) {
      setOncallAgent(null);
    } finally {
      setOncallLoading(false);
    }
  }

  // Helper function to extract just the name from PagerDuty summary
  function extractName(summary) {
    if (!summary) return 'None';
    
    // PagerDuty format is usually: "On Call - Name - OnCall" or similar
    // Extract the middle part (the actual name)
    const parts = summary.split('-').map(part => part.trim());
    
    // If there are multiple parts, return the middle one (usually the name)
    if (parts.length >= 2) {
      return parts[1];
    }
    
    // Otherwise just return the summary
    return summary;
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 8px',
      backgroundColor: '#06AC38',
      border: '1px solid #06AC38',
      borderRadius: '4px',
      fontSize: '11px',
      fontWeight: '600',
      marginLeft: '8px'
    }}>
      {/* PagerDuty Logo - D with exclamation mark */}
      <svg 
        width="12" 
        height="14" 
        viewBox="0 0 100 140" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        {/* The "D" shape */}
        <path 
          d="M 0 0 L 0 85 L 45 85 C 70 85 85 70 85 42.5 C 85 15 70 0 45 0 Z M 25 20 L 45 20 C 58 20 65 28 65 42.5 C 65 57 58 65 45 65 L 25 65 Z" 
          fill="#FFFFFF"
        />
        {/* The exclamation mark */}
        <rect 
          x="0" 
          y="100" 
          width="25" 
          height="40" 
          fill="#FFFFFF"
        />
      </svg>
      
      <span style={{ color: '#FFFFFF' }}>
        {oncallLoading ? 'Loading...' : oncallAgent 
          ? `${oncallAgent.status === 'upcoming' ? 'Next: ' : 'OnCall: '}${extractName(oncallAgent.name)}`
          : 'OnCall: None'}
      </span>
      {oncallAgent && (
        <button
          onClick={fetchOncallAgent}
          title="Refresh oncall status"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '0 2px',
            fontSize: '10px',
            color: '#FFFFFF'
          }}
        >
          🔄
        </button>
      )}
    </div>
  );
}

// Helper function for consistent status badge styling
function getStatusBadgeStyle(statusType) {
  const baseStyle = {
    padding: '6px 12px',        // Consistent padding
    borderRadius: '12px',
    fontSize: '10px',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    minWidth: '70px',           // Minimum width for consistency
    textAlign: 'center'         // Center the text
  };

  switch (statusType) {
    case 'available':
      return { ...baseStyle, backgroundColor: '#E8F5E8', color: '#2E7D0F' };
    case 'away':
      return { ...baseStyle, backgroundColor: '#FFF4CC', color: '#B54708' };
    case 'busy':
      return { ...baseStyle, backgroundColor: '#FBEAEA', color: '#CC3340' };
    default:
      return { ...baseStyle, backgroundColor: '#F8F9FA', color: '#68737D' };
  }
}

// Helper function to determine support level from subscriptions.
// Visualize tier is derived entirely from the subscriptions array; the
// account status flags below still come from tags because there is no
// subscription equivalent for "account on hold" or "maintenance expired".
function getSupportLevel(requesterOrg, subscriptions) {
  const tags = requesterOrg?.tags || [];

  // Amber caution fallback when no Visualize subscription exists
  const noSupportFound = {
    level: 'Contract Inactive',
    color: '#B54708',           // dark amber text
    bg: '#FFF4CC',              // pale yellow background
    border: '1px solid #F79A0A' // amber border
  };

  // CHECK FOR ACCOUNT STATUS ISSUES FIRST (highest priority)
  if (tags.some(tag => tag.toLowerCase().includes('account_hold') || tag.toLowerCase().includes('account-hold'))) {
    return { level: 'ACCOUNT ON HOLD', color: '#2F3941', bg: '#FFFFFF', border: '2px solid #CC3340', icon: '🚫' };
  }
  if (tags.some(tag => tag.toLowerCase().includes('maintenance_expired') || tag.toLowerCase().includes('maintenance-expired'))) {
    return { level: 'MAINTENANCE EXPIRED', color: '#2F3941', bg: '#FFFFFF', border: '2px solid #F79A0A', icon: '⚠️' };
  }

  // Visualize tier is determined entirely from subscriptions
  if (!subscriptions || subscriptions.length === 0) return noSupportFound;

  // Match "visualize" or "vis" as a standalone token
  // (bounded by start/end of string, space, hyphen, or underscore)
  const visualizeSubs = subscriptions.filter(sub => {
    const name = (sub.name || sub.product_name || '').toLowerCase();
    return /(?:^|[\s\-_])vis(ualize)?(?:[\s\-_]|$)/.test(name);
  });

  if (visualizeSubs.length === 0) return noSupportFound;

  // Scope tier matching to Visualize subs only so an unrelated
  // "Premium" product can't bleed into the Visualize tier.
  // Accepts both full ("premium") and shortened ("pre") forms.
  const hasTier = (keywords) => visualizeSubs.some(sub => {
    const name = (sub.name || sub.product_name || '').toLowerCase();
    return keywords.some(kw => name.includes(kw));
  });

  // Highest tier wins if multiple Visualize subs exist (e.g. during upgrades)
  if (hasTier(['premium', 'pre'])) {
    return { level: 'Premium', tier: 'Visualize', color: '#FFFFFF', bg: '#1F73B7' };
  }
  if (hasTier(['plus'])) {
    return { level: 'Plus', tier: 'Visualize', color: '#FFFFFF', bg: '#F79A0A' };
  }
  if (hasTier(['basic', 'bas'])) {
    return { level: 'Basic', tier: 'Visualize', color: '#FFFFFF', bg: '#CC3340' };
  }

  // Visualize sub present but no tier keyword — default to Basic
  return { level: 'Basic', tier: 'Visualize', color: '#FFFFFF', bg: '#CC3340' };
}

// Function to detect partner badge (Sangoma or Intermedia) - returns single badge
function getPartnerBadge(requesterOrg, subscriptions) {
  const tags = requesterOrg?.tags || [];
  
  // Check for Sangoma (priority 1)
  const hasSangoma = tags.some(tag => tag.toLowerCase().includes('sangoma')) ||
                     subscriptions.some(sub => (sub.name || sub.product_name || '').toLowerCase().includes('sangoma'));
  if (hasSangoma) {
    return { 
      name: 'Sangoma', 
      color: '#FFFFFF', 
      bg: '#4A4A4A' // Dark grey
    };
  }
  
  // Check for Intermedia (priority 2)
  const hasIntermedia = tags.some(tag => tag.toLowerCase().includes('intermedia')) ||
                        subscriptions.some(sub => (sub.name || sub.product_name || '').toLowerCase().includes('intermedia'));
  if (hasIntermedia) {
    return { 
      name: 'Intermedia', 
      color: '#FFFFFF', 
      bg: '#89CFF0' // Baby blue
    };
  }
  
  return null; // No partner badge found
}

// CustomerNotesCard Component
function CustomerNotesCard({ 
  customerNotes, 
  setCustomerNotes, 
  customerNotesSectionExpanded, 
  setCustomerNotesSectionExpanded,
  setShowAddNote,
  setEditingNote,
  setNoteForm,
  handleSaveCustomerNotes
}) {
  
  const handleDeleteNote = (noteId) => {
    const updatedNotes = customerNotes.filter(note => note.id !== noteId);
    setCustomerNotes(updatedNotes);
    console.log('[DEBUG SAVE] State updated! customerNotes is now:', updatedNotes);
    handleSaveCustomerNotes(updatedNotes);
  };

  const handleEditNote = (note) => {
    setEditingNote(note);
    setNoteForm({
      text: note.text,
      priority: note.priority || 'normal'
    });
    setShowAddNote(true);
  };

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      borderBottom: 'none',
      marginBottom: '0px',
      boxShadow: 'none'
    }}>
      <div
        onClick={() => setCustomerNotesSectionExpanded(!customerNotesSectionExpanded)}
        style={{
          cursor: "pointer",
          padding: "10px 12px",
          minHeight: '35px',
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: customerNotesSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
          </span>
          <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
            Customer Notes ({customerNotes.length})
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {customerNotesSectionExpanded && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingNote(null);
                setNoteForm({ text: '', priority: 'normal' });
                setShowAddNote(true);
              }}
              style={{
                backgroundColor: '#1F73B7',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '4px 8px',
                fontSize: '11px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              + Add Note
            </button>
          )}
          <span style={{ color: '#68737D', fontSize: '12px' }}>
            {customerNotesSectionExpanded ? "▼" : "▶"}
          </span>
        </div>
      </div>

      {customerNotesSectionExpanded && (
        <div style={{ padding: "12px" }}>
          {customerNotes.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '20px',
              color: '#68737D',
              fontSize: '12px'
            }}>
              No customer notes yet. Click "Add Note" to create one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {customerNotes.map((note) => {
                const priorityColors = {
                  high: { bg: '#FBEAEA', border: '#CC3340', text: '#CC3340' },
                  normal: { bg: '#FFF4CC', border: '#F79A0A', text: '#B54708' },
                  low: { bg: '#E8F5E8', border: '#2E7D0F', text: '#2E7D0F' }
                };
                
                const colors = priorityColors[note.priority || 'normal'];
                
                return (
                  <div
                    key={note.id}
                    style={{
                      border: `1px solid ${colors.border}`,
                      borderRadius: '6px',
                      backgroundColor: colors.bg,
                      padding: '12px',
                      fontSize: '12px'
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: '8px'
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          color: colors.text,
                          fontWeight: '600',
                          fontSize: '11px',
                          textTransform: 'uppercase',
                          marginBottom: '4px'
                        }}>
                          {note.priority === 'high' ? '🔴 HIGH PRIORITY' : 
                           note.priority === 'low' ? '🟢 LOW PRIORITY' : 
                           '🟡 NORMAL'}
                        </div>
                        <div style={{
                          color: '#2F3941',
                          lineHeight: '1.5',
                          wordBreak: 'break-word'
                        }}>
                          {note.text}
                        </div>
                      </div>
                      <div style={{
                        display: 'flex',
                        gap: '4px',
                        marginLeft: '8px',
                        flexShrink: 0
                      }}>
                        <button
                          onClick={() => handleEditNote(note)}
                          style={{
                            backgroundColor: 'white',
                            border: `1px solid ${colors.border}`,
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '10px',
                            color: colors.text,
                            cursor: 'pointer',
                            fontWeight: '500'
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteNote(note.id)}
                          style={{
                            backgroundColor: '#CC3340',
                            border: 'none',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            fontSize: '10px',
                            color: 'white',
                            cursor: 'pointer',
                            fontWeight: '500'
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    
                    {note.created_at && (
                      <div style={{
                        fontSize: '10px',
                        color: '#68737D',
                        marginTop: '8px',
                        paddingTop: '8px',
                        borderTop: '1px dashed rgba(0,0,0,0.1)'
                      }}>
                        Added {new Date(note.created_at).toLocaleDateString()} at {new Date(note.created_at).toLocaleTimeString()}
                        {note.created_by && ` by ${note.created_by}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// CustomerNoteModal Component
function CustomerNoteModal({
  open,
  onClose,
  noteForm,
  setNoteForm,
  editingNote,
  customerNotes,
  handleSaveCustomerNotes,
  setEditingNote
}) {
  
  const handleSave = () => {
    if (!noteForm.text?.trim()) {
      alert('Please enter note text');
      return;
    }

    let updatedNotes;
    
    if (editingNote) {
      // Update existing note
      updatedNotes = customerNotes.map(note =>
        note.id === editingNote.id
          ? { ...note, text: noteForm.text, priority: noteForm.priority }
          : note
      );
    } else {
      // Add new note
      const newNote = {
        id: `note-${Date.now()}`,
        text: noteForm.text,
        priority: noteForm.priority || 'normal',
        created_at: new Date().toISOString(),
        created_by: 'Current User'
      };
      updatedNotes = [...customerNotes, newNote];
    }

    handleSaveCustomerNotes(updatedNotes);
    setNoteForm({ text: '', priority: 'normal' });
    setEditingNote(null);
    onClose();
  };

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '20px',
        width: '90%',
        maxWidth: '500px',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
      }}>
        <h3 style={{
          margin: '0 0 16px 0',
          fontSize: '16px',
          fontWeight: '600',
          color: '#2F3941'
        }}>
          {editingNote ? 'Edit Customer Note' : 'Add Customer Note'}
        </h3>

        <div style={{ marginBottom: '16px' }}>
          <label style={{
            display: 'block',
            fontSize: '12px',
            fontWeight: '600',
            color: '#68737D',
            marginBottom: '6px'
          }}>
            Priority
          </label>
          <select
            value={noteForm.priority || 'normal'}
            onChange={(e) => setNoteForm({ ...noteForm, priority: e.target.value })}
            style={{
              width: '100%',
              padding: '8px',
              fontSize: '12px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              boxSizing: 'border-box'
            }}
          >
            <option value="low">🟢 Low Priority</option>
            <option value="normal">🟡 Normal</option>
            <option value="high">🔴 High Priority</option>
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{
            display: 'block',
            fontSize: '12px',
            fontWeight: '600',
            color: '#68737D',
            marginBottom: '6px'
          }}>
            Note Text *
          </label>
          <textarea
            value={noteForm.text || ''}
            onChange={(e) => setNoteForm({ ...noteForm, text: e.target.value })}
            placeholder="Enter customer note..."
            style={{
              width: '100%',
              minHeight: '100px',
              padding: '8px',
              fontSize: '12px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              fontFamily: 'inherit',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{
          display: 'flex',
          gap: '8px',
          justifyContent: 'flex-end'
        }}>
          <button
            onClick={() => {
              setNoteForm({ text: '', priority: 'normal' });
              setEditingNote(null);
              onClose();
            }}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              backgroundColor: 'white',
              color: '#68737D',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: '8px 16px',
              fontSize: '12px',
              backgroundColor: '#1F73B7',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            {editingNote ? 'Update Note' : 'Add Note'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Auto CC — agent-managed CC rules for this organization.
// Rules are persisted as JSON in the `auto_cc_rules` org field and
// evaluated per-ticket by the n8n workflow. This card is the editor;
// it does not itself CC anyone.
// ============================================================

// Scope vocabulary. Mirrors the four SEV -> priority triggers in Zendesk.
const CC_SCOPES = [
  { value: 'all_tickets', label: 'All tickets',    short: 'All tickets', fg: '#68737D', bg: '#F8F9FA' },
  { value: 'all_alarms',  label: 'All alarms',     short: 'All alarms',  fg: '#1F73B7', bg: '#E8F5F8' },
  { value: 'sev1',        label: 'SEV1 / Urgent',  short: 'SEV1',        fg: '#CC3340', bg: '#FBEAEA' },
  { value: 'sev2',        label: 'SEV2+ / High',   short: 'SEV2+',       fg: '#B54708', bg: '#FFF4CC' },
  { value: 'sev3',        label: 'SEV3+ / Normal', short: 'SEV3+',       fg: '#F79A0A', bg: '#FFF4CC' },
  { value: 'sev4',        label: 'SEV4+ / Low',    short: 'SEV4+',       fg: '#2E7D0F', bg: '#E8F5E8' }
];

const scopeMeta = (v) => CC_SCOPES.find(s => s.value === v) || CC_SCOPES[0];

// Severity rank for floor logic. Lower = more severe. Non-severity scopes
// (all_tickets/all_alarms) admit any severity, so their floor can be anything.
const SEV_ORDER = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 };

// Real-time floor options valid for a given rule scope. The floor is "also send
// real-time for anything this severe or worse," so it never makes sense for the
// floor to be LOOSER (higher severity number) than the scope already admits.
// e.g. a sev2 scope (SEV1-SEV2 only) can floor at sev1 or sev2, not sev3.
function floorOptionsForScope(scope) {
  const opts = [{ value: 'none', label: 'Nothing (pure digest)' }];
  const scopeRank = SEV_ORDER[scope];               // undefined for all_tickets/all_alarms
  for (const s of ['sev1', 'sev2', 'sev3', 'sev4']) {
    // if scope is a severity, only offer floors at least as severe as the scope
    if (scopeRank && SEV_ORDER[s] > scopeRank) continue;
    opts.push({ value: s, label: `${s.toUpperCase()} or worse, real-time` });
  }
  return opts;
}

// Ensure a stored floor never ends up looser than the rule's scope (which would
// make it inert). If the chosen floor is less severe than the scope allows, or
// invalid, fall back to 'none'.
function clampFloor(floor, scope) {
  if (!floor || floor === 'none') return 'none';
  const scopeRank = SEV_ORDER[scope];
  const floorRank = SEV_ORDER[floor];
  if (!floorRank) return 'none';
  if (scopeRank && floorRank > scopeRank) return scope; // clamp to scope's own level
  return floor;
}

// ---- Auto CC Card ----
function AutoCcCard({
  autoCcRules,
  autoCcSectionExpanded,
  setAutoCcSectionExpanded,
  setShowAddCcRule,
  setEditingCcRule,
  setCcRuleForm,
  handleSaveAutoCcRules,
  suppressions,  // read-only: used to explain an unexpectedly empty CC list
  parsedAlarm    // read-only: to say whether a mute actually applies to THIS ticket
}) {
  const [query, setQuery] = React.useState('');
  const [scopeFilter, setScopeFilter] = React.useState('all');
  const [showDeleteCcConfirm, setShowDeleteCcConfirm] = React.useState(false);
  const [ruleToDelete, setRuleToDelete] = React.useState(null);
  const [expandedRules, setExpandedRules] = React.useState({}); // ruleKey -> bool

  // Who is actually CC'd on THIS ticket right now. Read-only: agents edit CCs in
  // Zendesk's own field. This just closes the loop, since a rule that matches
  // nothing fails silently and would otherwise go unnoticed.
  const [collaborators, setCollaborators] = React.useState(null); // null = loading
  const [collabError, setCollabError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    async function loadCollaborators() {
      if (!window.ZAFClient) { setCollabError(true); return; }
      try {
        const client = window.ZAFClient.init();
        const data = await client.get('ticket.collaborators');
        const raw = data?.['ticket.collaborators'] || [];
        const emails = raw
          .map(c => (typeof c === 'string' ? c : (c?.email || c?.user?.email || '')))
          .map(e => String(e).trim())
          .filter(Boolean);
        if (!cancelled) { setCollaborators(emails); setCollabError(false); }
      } catch (err) {
        console.error('[Asset Manager] Could not read ticket collaborators:', err);
        if (!cancelled) { setCollabError(true); setCollaborators([]); }
      }
    }

    if (autoCcSectionExpanded) loadCollaborators();
    return () => { cancelled = true; };
  }, [autoCcSectionExpanded]);

  // An address CC'd on the ticket but not present in any rule was added by hand
  // (or is a leftover). Worth surfacing — it's the difference between "the rules
  // did this" and "someone did this".
  const ruleEmails = new Set(
    (autoCcRules || []).map(r => String(r.email || '').trim().toLowerCase()).filter(Boolean)
  );
  const isFromRule = (email) => ruleEmails.has(String(email).trim().toLowerCase());

  // Distinguish "a mute exists on this org" (weak signal) from "a mute actually
  // applies to the alarm on THIS ticket" (the real explanation for an empty CC
  // list). The earlier version only knew the former, which misled agents.
  const normalizeMute = (str) => String(str || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const activeMutes = (suppressions || []).filter(
    s => s?.expires_at && new Date(s.expires_at).getTime() > Date.now()
  );
  const activeMuteCount = activeMutes.length;

  const muteHaystack = parsedAlarm
    ? normalizeMute(`${parsedAlarm.company || ''} ${parsedAlarm.fqdn || ''} ${parsedAlarm.site || ''}`)
    : '';
  const muteObj = parsedAlarm ? normalizeMute(parsedAlarm.alarmType || '') : '';
  const mutesApplyingToTicket = (parsedAlarm && parsedAlarm.isAlarm)
    ? activeMutes.filter(s => {
        if (!s.device && !s.alarmType) return false;
        const d = !s.device    || muteHaystack.includes(normalizeMute(s.device));
        const a = !s.alarmType || muteObj.includes(normalizeMute(s.alarmType));
        return d && a;
      }).length
    : 0;

  const toggleRule = (key) =>
    setExpandedRules(prev => ({ ...prev, [key]: !prev[key] }));

  const SCOPE_ORDER = { all_tickets: 0, all_alarms: 1, sev1: 2, sev2: 3, sev3: 4, sev4: 5 };

  const filtered = React.useMemo(() => {
    return (autoCcRules || [])
      .filter(r => scopeFilter === 'all' ? true : r.scope === scopeFilter)
      .filter(r => {
        if (!query.trim()) return true;
        const hay = `${r.email ?? ''} ${(r.locationKeywords || []).join(' ')}`.toLowerCase();
        return hay.includes(query.toLowerCase());
      })
      .sort((a, b) => {
        const sA = SCOPE_ORDER[a.scope] ?? 99;
        const sB = SCOPE_ORDER[b.scope] ?? 99;
        if (sA !== sB) return sA - sB;
        return (a.email || '').localeCompare(b.email || '');
      });
  }, [autoCcRules, scopeFilter, query]);

  const hasLegacy = (autoCcRules || []).some(r => r.legacy);

  function quickRemove(rule) {
    setRuleToDelete(rule);
    setShowDeleteCcConfirm(true);
  }

  function confirmDeleteCc() {
    if (!ruleToDelete) return;
    const next = (autoCcRules || []).filter(r => r !== ruleToDelete);
    handleSaveAutoCcRules(next);
    setShowDeleteCcConfirm(false);
    setRuleToDelete(null);
  }

  function cancelDeleteCc() {
    setShowDeleteCcConfirm(false);
    setRuleToDelete(null);
  }

  function quickEdit(rule) {
    setEditingCcRule(rule);
    setCcRuleForm({
      email: rule.email || '',
      scope: rule.scope || 'all_alarms',
      locationKeywords: rule.locationKeywords || [],
      delivery: rule.delivery === 'digest' ? 'digest' : 'realtime',
      digestInterval: rule.digestInterval || 'daily',
      digestHour: Number.isInteger(rule.digestHour) ? rule.digestHour : 8,
      realtimeFloor: rule.realtimeFloor || 'none'
    });
    setShowAddCcRule(true);
  }

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      marginBottom: '0px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      width: '100%', boxSizing: 'border-box', overflow: 'hidden', wordBreak: 'break-word'
    }}>
      <div
        onClick={() => setAutoCcSectionExpanded(!autoCcSectionExpanded)}
        style={{
          cursor: 'pointer',
          padding: '10px 12px',
          minHeight: '35px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: autoCcSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#2F3941' }}>
            Alarm Recipients ({(autoCcRules || []).length})
          </span>
        </div>
        <span style={{ color: '#68737D', fontSize: 12 }}>
          {autoCcSectionExpanded ? '▼' : '▶'}
        </span>
      </div>

      {autoCcSectionExpanded && (
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div style={{
            fontSize: 11,
            color: '#68737D',
            backgroundColor: '#F8F9FA',
            border: '1px solid #D8DCDE',
            borderRadius: 6,
            padding: '8px 10px'
          }}>
            These addresses are CC'd automatically on this organization's tickets.
            Rules apply to <strong>new</strong> tickets only — editing them does not
            change tickets already open.
          </div>

          {hasLegacy && (
            <div style={{
              fontSize: 11,
              color: '#B54708',
              backgroundColor: '#FFF4CC',
              border: '1px solid #F79A0A',
              borderRadius: 6,
              padding: '8px 10px'
            }}>
              <strong>Not yet migrated.</strong> These addresses were read from the old
              Auto CC field and currently CC on <em>every</em> ticket, at every severity.
              Save any change to convert them into real rules — set the scopes first.
            </div>
          )}

          <div style={{ display: 'grid', gap: 12 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by email or location…"
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
              <select
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value)}
                style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', minWidth: 0 }}
                title="Filter by scope"
              >
                <option value="all">All scopes</option>
                {CC_SCOPES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  setShowAddCcRule(true);
                  setEditingCcRule(null);
                  setCcRuleForm({ email: '', scope: 'all_alarms', locationKeywords: [], delivery: 'realtime', digestInterval: 'daily', digestHour: 8, realtimeFloor: 'none' });
                }}
                style={{ padding: '6px 12px', fontSize: 11, backgroundColor: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                + Add Recipient
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#68737D', fontSize: 12, backgroundColor: '#F8F9FA', border: '1px dashed #D8DCDE', borderRadius: 6 }}>
              {(autoCcRules || []).length === 0
                ? "No auto CC rules — nobody is CC'd on this org's tickets"
                : 'No rules match your filters'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
              {filtered.map((rule, idx) => {
                const meta = scopeMeta(rule.scope);
                const kws = rule.locationKeywords || [];
                const ruleKey = rule.id ?? `${rule.email}-${idx}`;
                const isOpen = !!expandedRules[ruleKey];

                return (
                  <div
                    key={ruleKey}
                    style={{
                      borderRadius: 8,
                      border: '1px solid #D8DCDE',
                      backgroundColor: '#FFFFFF',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                      overflow: 'hidden'
                    }}
                  >
                    {/* Collapsed summary — always visible, click to toggle */}
                    <div
                      onClick={() => toggleRule(ruleKey)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: 10,
                        cursor: 'pointer'
                      }}
                    >
                      <span style={{ color: '#68737D', fontSize: 9, flexShrink: 0, width: 8 }}>
                        {isOpen ? '▼' : '▶'}
                      </span>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#2F3941',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {rule.email}
                        </div>
                        {!isOpen && (
                          <div style={{ fontSize: 10, color: '#68737D', marginTop: 2 }}>
                            {kws.length === 0
                              ? 'Any location'
                              : `${kws.length} location${kws.length === 1 ? '' : 's'}`}
                          </div>
                        )}
                      </div>

                      <span style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: meta.fg,
                        backgroundColor: meta.bg,
                        padding: '2px 8px',
                        borderRadius: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.3px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}>
                        {meta.short}
                      </span>
                    </div>

                    {/* Expanded detail */}
                    {isOpen && (
                      <div style={{
                        padding: '0 10px 10px 10px',
                        display: 'grid',
                        gap: 8,
                        borderTop: '1px solid #F1F3F5'
                      }}>
                        <div style={{ fontSize: 11, color: '#68737D', paddingTop: 8 }}>
                          {kws.length === 0 ? (
                            <span>Any location</span>
                          ) : (
                            <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                              {kws.map((kw, k) => (
                                <span key={k} style={{
                                  backgroundColor: '#F8F9FA',
                                  border: '1px solid #D8DCDE',
                                  borderRadius: 10,
                                  padding: '1px 7px',
                                  fontSize: 10,
                                  color: '#2F3941'
                                }}>
                                  {kw}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => quickEdit(rule)} title="Edit rule" style={ghostBtn('#1F73B7')}>Edit</button>
                          <button onClick={() => quickRemove(rule)} title="Remove rule" style={ghostBtn('#CC3340')}>Remove</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {autoCcSectionExpanded && (
        <div style={{ padding: '0 16px 16px 16px' }}>
          <div style={{
            border: '1px solid #D8DCDE',
            borderRadius: 8,
            backgroundColor: '#F8F9FA',
            padding: 10
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: '#2F3941',
              marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.3px'
            }}>
              Currently CC'd on this ticket
            </div>

            {collaborators === null ? (
              <div style={{ fontSize: 11, color: '#68737D' }}>Loading…</div>
            ) : collabError ? (
              <div style={{ fontSize: 11, color: '#68737D' }}>
                Couldn't read the CC list for this ticket.
              </div>
            ) : collaborators.length === 0 ? (
              <div style={{ fontSize: 11, color: '#68737D' }}>
                Nobody is CC'd on this ticket.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {collaborators.map((email, i) => {
                  const fromRule = isFromRule(email);
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 11, color: '#2F3941'
                    }}>
                      <span style={{
                        flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                      }}>
                        {email}
                      </span>
                      {!fromRule && (
                        <span
                          title="Not matched by any rule — added manually or left over from an old rule"
                          style={{
                            fontSize: 9, fontWeight: 600, color: '#B54708',
                            backgroundColor: '#FFF4CC', border: '1px solid #F79A0A',
                            padding: '1px 6px', borderRadius: 10,
                            textTransform: 'uppercase', letterSpacing: '0.3px',
                            whiteSpace: 'nowrap', flexShrink: 0
                          }}
                        >
                          Manual
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {mutesApplyingToTicket > 0 ? (
              <div style={{
                fontSize: 10, color: '#FFFFFF',
                backgroundColor: '#B54708', border: '1px solid #B54708',
                borderRadius: 4, padding: '6px 8px', marginTop: 8, fontWeight: 600
              }}>
                This alarm is muted — that's why the CC list is empty or short.
                See Muted Alarms below to review or clear it.
              </div>
            ) : activeMuteCount > 0 ? (
              <div style={{
                fontSize: 10, color: '#B54708',
                backgroundColor: '#FFF4CC', border: '1px solid #F79A0A',
                borderRadius: 4, padding: '5px 8px', marginTop: 8
              }}>
                {activeMuteCount} active {activeMuteCount === 1 ? 'mute' : 'mutes'} on this
                org, but {activeMuteCount === 1 ? 'it does not apply' : 'none apply'} to this
                alarm. CCs here follow the rules as normal.
              </div>
            ) : null}

            <div style={{
              fontSize: 10, color: '#68737D', marginTop: 8,
              paddingTop: 8, borderTop: '1px solid #E4E6E8'
            }}>
              To add or remove someone on this ticket, use Zendesk's CC field.
              Changing a rule here only affects <strong>future</strong> tickets.
            </div>
          </div>
        </div>
      )}

      {/* Delete CC Rule Confirmation */}
      {showDeleteCcConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2001
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '0',
            padding: '20px',
            width: '90%',
            maxWidth: '400px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)'
          }}>
            <div style={{ fontSize: '14px', fontWeight: '600', color: '#CC3340', marginBottom: '12px' }}>
              Remove CC Rule?
            </div>
            <div style={{ fontSize: '12px', color: '#2F3941', marginBottom: '16px' }}>
              {ruleToDelete?.email || 'This address'} will no longer be CC'd on this
              organization's tickets.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={cancelDeleteCc}
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  color: '#68737D',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteCc}
                style={{
                  backgroundColor: '#CC3340',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Auto CC Rule Modal (Add/Edit) ----
function AutoCcRuleModal({
  open,
  onClose,
  ccRuleForm,
  setCcRuleForm,
  editingCcRule,
  autoCcRules,
  handleSaveAutoCcRules,
  setEditingCcRule
}) {
  const [kwDraft, setKwDraft] = React.useState('');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (open) { setKwDraft(''); setError(''); }
  }, [open]);

  if (!open) return null;

  const kws = ccRuleForm.locationKeywords || [];

  function addKeyword() {
    const v = kwDraft.trim();
    if (!v) return;
    if (kws.some(k => k.toLowerCase() === v.toLowerCase())) { setKwDraft(''); return; }
    setCcRuleForm({ ...ccRuleForm, locationKeywords: [...kws, v] });
    setKwDraft('');
  }

  function removeKeyword(kw) {
    setCcRuleForm({ ...ccRuleForm, locationKeywords: kws.filter(k => k !== kw) });
  }

  function onKwKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKeyword();
    }
  }

  function onSubmit(e) {
    e.preventDefault();

    const email = (ccRuleForm.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }

    // Two rules for one address is almost always a mistake.
    const dupe = (autoCcRules || []).some(r =>
      r !== editingCcRule &&
      (r.email || '').trim().toLowerCase() === email.toLowerCase()
    );
    if (dupe) {
      setError('A rule for this address already exists.');
      return;
    }

    // Fold in a keyword still sitting in the input so it isn't silently dropped.
    const pending = kwDraft.trim();
    const finalKws = pending && !kws.some(k => k.toLowerCase() === pending.toLowerCase())
      ? [...kws, pending]
      : kws;

    const next = [...(autoCcRules || [])];

    if (editingCcRule) {
      const idx = next.findIndex(r =>
        r === editingCcRule ||
        (r?.id && r.id === editingCcRule?.id) ||
        r?.email === editingCcRule?.email
      );
      const base = idx >= 0 ? next[idx] : editingCcRule;
      const updated = {
        ...base,
        email,
        scope: ccRuleForm.scope || 'all_alarms',
        locationKeywords: finalKws,
        // Delivery mode. Absent/'realtime' = CC on every matching alarm (default,
        // backward compatible). 'digest' = suppressed in real time; summarized by
        // the scheduled digest workflow instead.
        delivery: ccRuleForm.delivery === 'digest' ? 'digest' : 'realtime',
        digestInterval: ccRuleForm.delivery === 'digest' ? (ccRuleForm.digestInterval || 'daily') : undefined,
        digestHour: ccRuleForm.delivery === 'digest'
          ? (Number.isInteger(ccRuleForm.digestHour) ? ccRuleForm.digestHour : 8)
          : undefined,
        // Real-time floor: also send immediately for alarms this severe or worse,
        // even in digest mode. Clamped so it can't be looser than scope.
        realtimeFloor: ccRuleForm.delivery === 'digest'
          ? clampFloor(ccRuleForm.realtimeFloor, ccRuleForm.scope)
          : undefined
      };
      // Keep the stored rule clean: strip digest keys entirely when realtime.
      if (updated.delivery !== 'digest') {
        delete updated.digestInterval;
        delete updated.digestHour;
        delete updated.realtimeFloor;
      }
      // 'none' floor is the default; don't store it.
      if (updated.realtimeFloor === 'none') delete updated.realtimeFloor;
      delete updated.legacy; // promoted out of the legacy field
      if (!updated.created_at) updated.created_at = new Date().toISOString();
      if (idx >= 0) next[idx] = updated; else next.push(updated);
    } else {
      const newRule = {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : (Date.now().toString(36) + Math.random().toString(36).slice(2))),
        email,
        scope: ccRuleForm.scope || 'all_alarms',
        locationKeywords: finalKws,
        delivery: ccRuleForm.delivery === 'digest' ? 'digest' : 'realtime',
        created_at: new Date().toISOString()
      };
      if (newRule.delivery === 'digest') {
        newRule.digestInterval = ccRuleForm.digestInterval || 'daily';
        newRule.digestHour = Number.isInteger(ccRuleForm.digestHour) ? ccRuleForm.digestHour : 8;
        const floor = clampFloor(ccRuleForm.realtimeFloor, ccRuleForm.scope);
        if (floor && floor !== 'none') newRule.realtimeFloor = floor;
      }
      next.push(newRule);
    }

    handleSaveAutoCcRules(next);
    setEditingCcRule(null);
    onClose();
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
    }}>
      <div style={{ backgroundColor: '#FFFFFF', borderRadius: 8, width: 'min(560px, 92vw)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #D8DCDE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, color: '#2F3941' }}>
            {editingCcRule ? 'Edit Recipient' : 'Add Recipient'}
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <form onSubmit={onSubmit} style={{ padding: 16, display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Email address
            <input
              type="email"
              value={ccRuleForm.email}
              onChange={(e) => { setCcRuleForm({ ...ccRuleForm, email: e.target.value }); setError(''); }}
              required
              placeholder="name@customer.com"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6 }}
            />
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            CC on
            <select
              value={ccRuleForm.scope}
              onChange={(e) => setCcRuleForm({ ...ccRuleForm, scope: e.target.value })}
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6 }}
            >
              {CC_SCOPES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              {ccRuleForm.scope === 'all_tickets'
                ? 'Every ticket for this org, including ones filed by a person.'
                : ccRuleForm.scope === 'all_alarms'
                  ? 'Every alarm ticket, at any severity.'
                  : ccRuleForm.scope === 'sev1'
                    ? 'Alarm tickets at SEV1 only.'
                    : `Alarm tickets at ${scopeMeta(ccRuleForm.scope).short.replace('+', '')} or higher severity.`}
            </div>
          </label>

          <div style={{ fontSize: 12, color: '#2F3941' }}>
            Delivery
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setCcRuleForm({ ...ccRuleForm, delivery: 'realtime' })}
                style={{
                  flex: 1, padding: '7px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                  border: ccRuleForm.delivery !== 'digest' ? '1.5px solid #1F73B7' : '1px solid #D8DCDE',
                  backgroundColor: ccRuleForm.delivery !== 'digest' ? '#E8F5F8' : '#FFFFFF',
                  color: ccRuleForm.delivery !== 'digest' ? '#1F5FA8' : '#68737D',
                  fontWeight: ccRuleForm.delivery !== 'digest' ? 600 : 400
                }}
              >
                Real-time
              </button>
              <button
                type="button"
                onClick={() => setCcRuleForm({ ...ccRuleForm, delivery: 'digest', digestInterval: ccRuleForm.digestInterval || 'daily', digestHour: Number.isInteger(ccRuleForm.digestHour) ? ccRuleForm.digestHour : 8 })}
                style={{
                  flex: 1, padding: '7px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                  border: ccRuleForm.delivery === 'digest' ? '1.5px solid #1F73B7' : '1px solid #D8DCDE',
                  backgroundColor: ccRuleForm.delivery === 'digest' ? '#E8F5F8' : '#FFFFFF',
                  color: ccRuleForm.delivery === 'digest' ? '#1F5FA8' : '#68737D',
                  fontWeight: ccRuleForm.delivery === 'digest' ? 600 : 400
                }}
              >
                Digest
              </button>
            </div>

            {ccRuleForm.delivery === 'digest' ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <select
                  value={ccRuleForm.digestInterval || 'daily'}
                  onChange={(e) => setCcRuleForm({ ...ccRuleForm, digestInterval: e.target.value })}
                  style={{ flex: 1, padding: '7px', fontSize: 11, border: '1px solid #D8DCDE', borderRadius: 6 }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly (Mon)</option>
                </select>
                <select
                  value={Number.isInteger(ccRuleForm.digestHour) ? ccRuleForm.digestHour : 8}
                  onChange={(e) => setCcRuleForm({ ...ccRuleForm, digestHour: parseInt(e.target.value, 10) })}
                  style={{ flex: 1, padding: '7px', fontSize: 11, border: '1px solid #D8DCDE', borderRadius: 6 }}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {ccRuleForm.delivery === 'digest' ? (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, color: '#68737D', marginBottom: 3 }}>Also send real-time for:</div>
                <select
                  value={ccRuleForm.realtimeFloor || 'none'}
                  onChange={(e) => setCcRuleForm({ ...ccRuleForm, realtimeFloor: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '7px', fontSize: 11, border: '1px solid #D8DCDE', borderRadius: 6 }}
                >
                  {floorOptionsForScope(ccRuleForm.scope).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            ) : null}

            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              {ccRuleForm.delivery === 'digest'
                ? `One summary email ${ccRuleForm.digestInterval === 'weekly' ? 'each Monday' : 'per day'}${ccRuleForm.realtimeFloor && ccRuleForm.realtimeFloor !== 'none' ? `, plus real-time for ${ccRuleForm.realtimeFloor.toUpperCase()}+` : ''}. Same scope and mutes apply.`
                : 'An email for every matching alarm, as it happens.'}
            </div>
          </div>

          <div style={{ fontSize: 12, color: '#2F3941' }}>
            Site / location keywords
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
              border: '1px solid #D8DCDE', borderRadius: 6, padding: 6, marginTop: 4,
              backgroundColor: '#FFFFFF'
            }}>
              {kws.map((kw, i) => (
                <span key={i} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  backgroundColor: '#E8F5F8', border: '1px solid #1F73B7',
                  color: '#1F73B7', borderRadius: 12, padding: '2px 8px', fontSize: 11
                }}>
                  {kw}
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    style={{ border: 'none', background: 'transparent', color: '#1F73B7', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                value={kwDraft}
                onChange={(e) => setKwDraft(e.target.value)}
                onKeyDown={onKwKeyDown}
                onBlur={addKeyword}
                placeholder={kws.length === 0 ? 'Type a site or address, press Enter…' : 'Add another…'}
                style={{ flex: 1, minWidth: 140, border: 'none', outline: 'none', fontSize: 12, padding: '4px' }}
              />
            </div>
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              {kws.length === 0
                ? 'Leave empty to CC on alarms from anywhere. Add keywords to limit this rule to matching sites — e.g. "Beverly Hospital" or "29 Mall Rd".'
                : "CC only when the alarm's device name or location contains one of these."}
            </div>
          </div>

          {error && (
            <div style={{
              fontSize: 11, color: '#CC3340', backgroundColor: '#FBEAEA',
              border: '1px solid #CC3340', borderRadius: 6, padding: '6px 10px'
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #D8DCDE', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" style={{ background: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              {editingCcRule ? 'Save Changes' : 'Add Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Muted Alarms — agent-managed CC muting.
// NOTE: this mutes the *notification*, not the alarm. The alarm still fires and
// the ticket is still created; nobody is CC'd on it.
// Persisted as JSON in the `auto_cc_blocked` org field. Evaluated by n8n BEFORE
// any CC rules: a live mute suppresses the CC entirely, for every recipient.
// Expiry is mandatory — mutes are meant to be temporary, and a silently
// permanent one hides real problems.
// ============================================================

// Quick presets sit alongside the date picker — "7 days from now" is tedious
// to work out by hand, but the picker is authoritative.
const SUPPRESS_PRESETS = [
  { label: '+1 day',   days: 1 },
  { label: '+7 days',  days: 7 },
  { label: '+30 days', days: 30 },
  { label: '+90 days', days: 90 }
];

// <input type="date"> speaks 'YYYY-MM-DD' in LOCAL time. Mutes are stored
// as ISO instants. These convert between the two without tripping over timezones.
const toDateInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Expire at end of the chosen local day, so "expires Jul 20" means the 20th is
// still silenced — matching how a person reads a date.
const fromDateInput = (val) => {
  if (!val) return null;
  const [y, m, d] = val.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
};

const addDaysInput = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateInput(d.toISOString());
};

// Earliest selectable date is tomorrow — a same-day expiry is almost always a typo.
const minExpiryInput = () => addDaysInput(1);

const formatExpiry = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const isExpired = (s) => {
  if (!s?.expires_at) return false;
  return new Date(s.expires_at).getTime() <= Date.now();
};

// "3 days left" / "expired 2 days ago"
function expiryText(s) {
  if (!s?.expires_at) return '';
  const ms = new Date(s.expires_at).getTime() - Date.now();
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor(abs / 3600000);
  const mins = Math.floor(abs / 60000);

  let qty;
  if (days >= 1) qty = `${days} day${days === 1 ? '' : 's'}`;
  else if (hours >= 1) qty = `${hours} hour${hours === 1 ? '' : 's'}`;
  else qty = `${mins} minute${mins === 1 ? '' : 's'}`;

  return ms > 0 ? `${qty} left` : `expired ${qty} ago`;
}

function SuppressedAlarmsCard({
  suppressions,
  suppressSectionExpanded,
  setSuppressSectionExpanded,
  setShowAddSuppress,
  setEditingSuppress,
  setSuppressForm,
  handleSaveSuppressions,
  parsedAlarm
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [toDelete, setToDelete] = React.useState(null);

  const list = suppressions || [];
  const active = list.filter(s => !isExpired(s));
  const expired = list.filter(s => isExpired(s));

  // --- Does a mute apply to the alarm on THIS ticket? ---
  // Mirrors the n8n matcher exactly (same normalize, same Company+Name+Location
  // haystack, same blank=any semantics) so the badge can't disagree with what
  // n8n actually did. If these ever drift, the badge lies — so keep them identical.
  const normalize = (str) => String(str || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const alarmHaystack = parsedAlarm
    ? normalize(`${parsedAlarm.company || ''} ${parsedAlarm.fqdn || ''} ${parsedAlarm.site || ''}`)
    : '';
  const alarmObj = parsedAlarm ? normalize(parsedAlarm.alarmType || '') : '';

  const muteAppliesToTicket = (s) => {
    if (!parsedAlarm || !parsedAlarm.isAlarm) return false;
    if (isExpired(s)) return false;
    if (!s.device && !s.alarmType) return false;
    const devMatch = !s.device    || alarmHaystack.includes(normalize(s.device));
    const altMatch = !s.alarmType || alarmObj.includes(normalize(s.alarmType));
    return devMatch && altMatch;
  };

  // --- Expiry-soon: active mutes lapsing within 7 days ---
  const SOON_MS = 7 * 24 * 3600 * 1000;
  const expiringSoon = (s) => {
    if (isExpired(s)) return false;
    const ms = new Date(s.expires_at).getTime() - Date.now();
    return ms > 0 && ms <= SOON_MS;
  };
  const soonCount = active.filter(expiringSoon).length;
  const appliesCount = active.filter(muteAppliesToTicket).length;

  // Active first, then soonest-to-expire; expired last, most recent first.
  const ordered = [
    ...active.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at)),
    ...expired.sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))
  ];

  function askDelete(s) { setToDelete(s); setShowDeleteConfirm(true); }
  function confirmDelete() {
    if (!toDelete) return;
    handleSaveSuppressions(list.filter(s => s !== toDelete));
    setShowDeleteConfirm(false);
    setToDelete(null);
  }
  function cancelDelete() { setShowDeleteConfirm(false); setToDelete(null); }

  function openEdit(s) {
    setEditingSuppress(s);
    // Clean any Unicode dashes that a legacy entry may have stored, so simply
    // opening and re-saving an old broken mute repairs it.
    const clean = (v) => String(v || '').replace(/[\u2010-\u2015]/g, '-');
    setSuppressForm({
      device: clean(s.device),
      alarmType: clean(s.alarmType),
      note: s.note || '',
      // Expired entries default to a week out; live ones keep their current date.
      expiresOn: isExpired(s) ? addDaysInput(7) : (toDateInput(s.expires_at) || addDaysInput(7))
    });
    setShowAddSuppress(true);
  }

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      marginBottom: '0px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      width: '100%', boxSizing: 'border-box', overflow: 'hidden', wordBreak: 'break-word'
    }}>
      <div
        onClick={() => setSuppressSectionExpanded(!suppressSectionExpanded)}
        style={{
          cursor: 'pointer',
          padding: '10px 12px',
          minHeight: '35px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: suppressSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              <path d="M18.63 13A17.9 17.9 0 0 1 18 8" />
              <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
              <path d="M18 8a6 6 0 0 0-9.33-5" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#2F3941' }}>
            Muted Alarms ({active.length} active{appliesCount > 0 ? `, ${appliesCount} on this alarm` : ''}{soonCount > 0 ? `, ${soonCount} expiring` : ''})
          </span>
        </div>
        <span style={{ color: '#68737D', fontSize: 12 }}>
          {suppressSectionExpanded ? '▼' : '▶'}
        </span>
      </div>

      {suppressSectionExpanded && (
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div style={{
            fontSize: 11, color: '#68737D',
            backgroundColor: '#F8F9FA', border: '1px solid #D8DCDE',
            borderRadius: 6, padding: '8px 10px'
          }}>
            Muting stops <strong>all</strong> auto CC for matching alarms — nobody is
            notified, regardless of their CC rules. The alarm still fires and the ticket
            is still created. Mutes expire on their own; expired ones stay here for
            reference until cleared.
          </div>

          {parsedAlarm && parsedAlarm.isAlarm && (parsedAlarm.fqdn || parsedAlarm.alarmType) && (
            <div style={{
              border: '1px solid #1F73B7',
              backgroundColor: '#F2F8FC',
              borderRadius: 6,
              padding: '10px 12px'
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#1F5FA8', marginBottom: 6 }}>
                Mute the alarm on this ticket
              </div>
              <div style={{ fontSize: 11, color: '#2F3941', marginBottom: 8, lineHeight: 1.5 }}>
                {parsedAlarm.fqdn && (
                  <div><span style={{ color: '#68737D' }}>Host </span><span style={{ fontFamily: 'monospace', fontSize: 10 }}>{parsedAlarm.fqdn}</span></div>
                )}
                {parsedAlarm.alarmType && (
                  <div><span style={{ color: '#68737D' }}>Alarm </span><span style={{ fontFamily: 'monospace', fontSize: 10 }}>{parsedAlarm.alarmType}</span></div>
                )}
              </div>
              <button
                onClick={() => {
                  setShowAddSuppress(true);
                  setEditingSuppress(null);
                  setSuppressForm({
                    device: parsedAlarm.fqdn || '',
                    alarmType: parsedAlarm.alarmType || '',
                    note: '',
                    expiresOn: addDaysInput(7)
                  });
                }}
                style={{ padding: '6px 12px', fontSize: 11, backgroundColor: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 4, cursor: 'pointer', width: '100%' }}
              >
                Mute this alarm →
              </button>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                setShowAddSuppress(true);
                setEditingSuppress(null);
                setSuppressForm({ device: '', alarmType: '', note: '', expiresOn: addDaysInput(7) });
              }}
              style={{ padding: '6px 12px', fontSize: 11, backgroundColor: 'transparent', color: '#1F73B7', border: '1px solid #1F73B7', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              + Mute manually
            </button>
          </div>

          {ordered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#68737D', fontSize: 12, backgroundColor: '#F8F9FA', border: '1px dashed #D8DCDE', borderRadius: 6 }}>
              No muted alarms — every alarm CCs normally
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ordered.map((s, idx) => {
                const dead = isExpired(s);
                const anyDevice = !s.device;
                const anyAlarm = !s.alarmType;
                // Strip any Unicode dash for DISPLAY, so a legacy mute stored with
                // an en-dash reads cleanly even before it's been re-saved. Matching
                // already normalizes, so this only affects what the agent sees.
                const dispDash = (v) => String(v || '').replace(/[\u2010-\u2015]/g, '-');
                const applies = muteAppliesToTicket(s);
                const soon = expiringSoon(s);

                return (
                  <div
                    key={s.id ?? idx}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: applies
                        ? '2px solid #1F73B7'
                        : (dead ? '1px solid #E4E6E8' : '1px solid #F79A0A'),
                      backgroundColor: applies ? '#F2F8FC' : (dead ? '#FAFBFC' : '#FFFDF5'),
                      opacity: dead ? 0.75 : 1
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600,
                        color: dead ? '#68737D' : '#B54708',
                        backgroundColor: dead ? '#F1F3F5' : '#FFF4CC',
                        padding: '2px 8px', borderRadius: 12,
                        textTransform: 'uppercase', letterSpacing: '0.3px',
                        whiteSpace: 'nowrap', flexShrink: 0
                      }}>
                        {dead ? 'Expired' : 'Muted'}
                      </span>
                      {applies && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: '#FFFFFF',
                          backgroundColor: '#1F73B7',
                          padding: '2px 8px', borderRadius: 12,
                          textTransform: 'uppercase', letterSpacing: '0.3px',
                          whiteSpace: 'nowrap', flexShrink: 0
                        }}>
                          Applies to this alarm
                        </span>
                      )}
                      <span style={{
                        fontSize: 11,
                        color: soon ? '#CC3340' : (dead ? '#68737D' : '#B54708'),
                        fontWeight: soon ? 600 : 400,
                        flex: 1, minWidth: 0
                      }}>
                        {expiryText(s)}
                        <span style={{ color: '#68737D', marginLeft: 5, fontWeight: 400 }}>
                          ({formatExpiry(s.expires_at)})
                        </span>
                      </span>
                    </div>

                    {soon && (
                      <div style={{
                        fontSize: 10, color: '#CC3340',
                        backgroundColor: '#FBEAEA', border: '1px solid #CC3340',
                        borderRadius: 4, padding: '4px 8px', marginBottom: 6
                      }}>
                        Expiring soon — alarms will start CCing again on {formatExpiry(s.expires_at)}.
                        Extend it if the underlying issue isn't resolved.
                      </div>
                    )}

                    <div style={{ display: 'grid', gap: 3, fontSize: 11, marginBottom: 6 }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span style={{ color: '#68737D', minWidth: 46, flexShrink: 0 }}>Device</span>
                        <span style={{
                          color: anyDevice ? '#68737D' : '#2F3941',
                          fontStyle: anyDevice ? 'italic' : 'normal',
                          fontFamily: anyDevice ? 'inherit' : 'monospace',
                          fontSize: anyDevice ? 11 : 10,
                          wordBreak: 'break-all'
                        }}>
                          {anyDevice ? 'any device' : dispDash(s.device)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span style={{ color: '#68737D', minWidth: 46, flexShrink: 0 }}>Alarm</span>
                        <span style={{
                          color: anyAlarm ? '#68737D' : '#2F3941',
                          fontStyle: anyAlarm ? 'italic' : 'normal',
                          fontFamily: anyAlarm ? 'inherit' : 'monospace',
                          fontSize: anyAlarm ? 11 : 10,
                          wordBreak: 'break-all'
                        }}>
                          {anyAlarm ? 'any alarm type' : dispDash(s.alarmType)}
                        </span>
                      </div>
                    </div>

                    {s.note && (
                      <div style={{
                        fontSize: 11, color: '#2F3941',
                        backgroundColor: '#FFFFFF',
                        border: '1px solid #E4E6E8',
                        borderRadius: 4, padding: '5px 8px', marginBottom: 6
                      }}>
                        {s.note}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => openEdit(s)}
                        title={dead ? 'Re-arm this mute' : 'Edit'}
                        style={ghostBtn('#1F73B7')}
                      >
                        {dead ? 'Extend' : 'Edit'}
                      </button>
                      <button onClick={() => askDelete(s)} title="Clear" style={ghostBtn('#CC3340')}>Clear</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showDeleteConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2001
        }}>
          <div style={{
            backgroundColor: '#FFFFFF', borderRadius: '0', padding: '20px',
            width: '90%', maxWidth: '400px', boxShadow: '0 8px 24px rgba(0,0,0,0.2)'
          }}>
            <div style={{ fontSize: '14px', fontWeight: '600', color: '#CC3340', marginBottom: '12px' }}>
              Unmute Alarm?
            </div>
            <div style={{ fontSize: '12px', color: '#2F3941', marginBottom: '16px' }}>
              {isExpired(toDelete)
                ? 'This mute has already expired and is not blocking anything. Clearing removes it from the list.'
                : 'Matching alarms will start CCing again immediately.'}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={cancelDelete} style={{
                backgroundColor: 'transparent', border: '1px solid #D8DCDE', borderRadius: '4px',
                padding: '6px 12px', fontSize: '11px', color: '#68737D', cursor: 'pointer'
              }}>Cancel</button>
              <button onClick={confirmDelete} style={{
                backgroundColor: '#CC3340', color: '#FFFFFF', border: 'none', borderRadius: '4px',
                padding: '6px 12px', fontSize: '11px', cursor: 'pointer'
              }}>Clear</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Mute Alarm Modal (Add / Edit / Extend) ----
function SuppressAlarmModal({
  open,
  onClose,
  suppressForm,
  setSuppressForm,
  editingSuppress,
  suppressions,
  handleSaveSuppressions,
  setEditingSuppress
}) {
  const [error, setError] = React.useState('');

  React.useEffect(() => { if (open) setError(''); }, [open]);

  if (!open) return null;

  const wasExpired = editingSuppress && isExpired(editingSuppress);

  function onSubmit(e) {
    e.preventDefault();

    // Convert any Unicode dash (en/em/figure) to a plain hyphen. Copy-paste from
    // rendered ticket text often carries en-dashes, which would never match the
    // hyphens in the raw alarm payload. n8n normalizes too, but fixing it at
    // entry keeps the stored value clean.
    const dedash = (s) => String(s || '').replace(/[\u2010-\u2015]/g, '-');
    const device = dedash((suppressForm.device || '').trim());
    const alarmType = dedash((suppressForm.alarmType || '').trim());

    // Guard the footgun: blank + blank silences every alarm for the whole org.
    if (!device && !alarmType) {
      setError('Specify a device, an alarm type, or both. Leaving both blank would mute every alarm for this organization.');
      return;
    }

    const expires_at = fromDateInput(suppressForm.expiresOn);
    if (!expires_at) {
      setError('Choose an expiry date.');
      return;
    }
    if (new Date(expires_at).getTime() <= Date.now()) {
      setError('Expiry must be in the future.');
      return;
    }

    const next = [...(suppressions || [])];

    if (editingSuppress) {
      const idx = next.findIndex(s => s === editingSuppress || (s?.id && s.id === editingSuppress.id));
      const base = idx >= 0 ? next[idx] : editingSuppress;
      const updated = {
        ...base,
        device,
        alarmType,
        note: (suppressForm.note || '').trim(),
        expires_at   // editing/extending always re-arms from now
      };
      if (idx >= 0) next[idx] = updated; else next.push(updated);
    } else {
      next.push({
        id: (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : (Date.now().toString(36) + Math.random().toString(36).slice(2))),
        device,
        alarmType,
        note: (suppressForm.note || '').trim(),
        created_at: new Date().toISOString(),
        expires_at
      });
    }

    handleSaveSuppressions(next);
    setEditingSuppress(null);
    onClose();
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
    }}>
      <div style={{ backgroundColor: '#FFFFFF', borderRadius: 8, width: 'min(560px, 92vw)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #D8DCDE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, color: '#2F3941' }}>
            {!editingSuppress ? 'Mute Alarm' : wasExpired ? 'Extend Mute' : 'Edit Mute'}
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <form onSubmit={onSubmit} style={{ padding: 16, display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Device
            <input
              value={suppressForm.device}
              onChange={(e) => { setSuppressForm({ ...suppressForm, device: e.target.value.replace(/[\u2010-\u2015]/g, '-') }); setError(''); }}
              placeholder="e.g. plt-acm-2.rocklandtrust.net"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontFamily: 'monospace', fontSize: 11 }}
            />
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              Matched against the alarm's device name, FQDN, or IP. Leave blank to mute
              this alarm type on <strong>every</strong> device.
            </div>
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Alarm type
            <input
              value={suppressForm.alarmType}
              onChange={(e) => { setSuppressForm({ ...suppressForm, alarmType: e.target.value.replace(/[\u2010-\u2015]/g, '-') }); setError(''); }}
              placeholder="e.g. avEntFanFlt"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontFamily: 'monospace', fontSize: 11 }}
            />
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              The alarm's Maint Object. Leave blank to mute <strong>all</strong> alarms
              from the device above.
            </div>
          </label>

          <div style={{ fontSize: 12, color: '#2F3941' }}>
            Mute until
            <input
              type="date"
              value={suppressForm.expiresOn || ''}
              min={minExpiryInput()}
              onChange={(e) => { setSuppressForm({ ...suppressForm, expiresOn: e.target.value }); setError(''); }}
              required
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4,
                border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12,
                color: '#2F3941', backgroundColor: '#FFFFFF'
              }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {SUPPRESS_PRESETS.map(p => {
                const val = addDaysInput(p.days);
                const on = suppressForm.expiresOn === val;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setSuppressForm({ ...suppressForm, expiresOn: val }); setError(''); }}
                    style={{
                      padding: '3px 9px', fontSize: 10, borderRadius: 12, cursor: 'pointer',
                      border: on ? '1px solid #1F73B7' : '1px solid #D8DCDE',
                      backgroundColor: on ? '#E8F5F8' : '#FFFFFF',
                      color: on ? '#1F73B7' : '#68737D',
                      fontWeight: on ? 600 : 400
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 6 }}>
              {suppressForm.expiresOn
                ? `Alarms stay muted through ${formatExpiry(fromDateInput(suppressForm.expiresOn))}, then CC normally again.`
                : 'Alarms resume CCing automatically once this date passes.'}
            </div>
          </div>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Reason
            <textarea
              value={suppressForm.note}
              onChange={(e) => setSuppressForm({ ...suppressForm, note: e.target.value })}
              rows={2}
              placeholder="e.g. Known bad fan sensor — RMA pending"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, resize: 'vertical', fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              Optional, but the next agent will thank you.
            </div>
          </label>

          {error && (
            <div style={{
              fontSize: 11, color: '#CC3340', backgroundColor: '#FBEAEA',
              border: '1px solid #CC3340', borderRadius: 6, padding: '6px 10px'
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #D8DCDE', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" style={{ background: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              {!editingSuppress ? 'Mute' : wasExpired ? 'Extend' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Escalation Contacts — who to call at the CUSTOMER when things go badly.
// Read-only reference; no automation. Distinct from the Escalate Ticket card,
// which reassigns internally to Intlx groups/engineers.
// Persisted as JSON in the `escalation_contacts` org field. Order is meaningful:
// contact #1 first, then #2, and so on.
// ============================================================

function EscalationContactsCard({
  escalationContacts,
  escalationProcedure,
  handleSaveEscalationProcedure,
  contactsSectionExpanded,
  setContactsSectionExpanded,
  setShowAddContact,
  setEditingContact,
  setContactForm,
  handleSaveEscalationContacts
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [toDelete, setToDelete] = React.useState(null);

  // The procedure governs the contacts — for some customers the list is an
  // explicit fallback ("use ONLY if unable to reach On Call"), so it has to be
  // read first, not discovered after someone has already dialled.
  const [editingProcedure, setEditingProcedure] = React.useState(false);
  const [procedureDraft, setProcedureDraft] = React.useState('');

  const list = escalationContacts || [];
  const procedure = (escalationProcedure || '').trim();

  function startEditProcedure() {
    setProcedureDraft(escalationProcedure || '');
    setEditingProcedure(true);
  }
  function saveProcedure() {
    handleSaveEscalationProcedure(procedureDraft);
    setEditingProcedure(false);
  }
  function cancelEditProcedure() {
    setEditingProcedure(false);
    setProcedureDraft('');
  }

  // Contacts grouped by site label, preserving list order within each group.
  // A contact with no site falls into a trailing "no label" bucket.
  const grouped = [];
  const seen = {};
  list.forEach((c) => {
    const key = (c.site || '').trim() || '__none__';
    if (!(key in seen)) { seen[key] = grouped.length; grouped.push({ site: key, items: [] }); }
    grouped[seen[key]].items.push(c);
  });

  function askDelete(c) { setToDelete(c); setShowDeleteConfirm(true); }
  function confirmDelete() {
    if (!toDelete) return;
    handleSaveEscalationContacts(list.filter(c => c !== toDelete));
    setShowDeleteConfirm(false);
    setToDelete(null);
  }
  function cancelDelete() { setShowDeleteConfirm(false); setToDelete(null); }

  function openEdit(c) {
    setEditingContact(c);
    setContactForm({
      name: c.name || '',
      site: c.site || '',
      role: c.role || '',
      phone: c.phone || '',
      email: c.email || '',
      note: c.note || ''
    });
    setShowAddContact(true);
  }

  // Order is the whole point — "call Maria first" is what an agent needs at 2am.
  function move(idx, delta) {
    const next = [...list];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    handleSaveEscalationContacts(next);
  }

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      marginBottom: '0px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      width: '100%', boxSizing: 'border-box', overflow: 'hidden', wordBreak: 'break-word'
    }}>
      <div
        onClick={() => setContactsSectionExpanded(!contactsSectionExpanded)}
        style={{
          cursor: 'pointer',
          padding: '10px 12px',
          minHeight: '35px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: contactsSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#2F3941' }}>
            Escalation Contacts ({list.length})
          </span>
        </div>
        <span style={{ color: '#68737D', fontSize: 12 }}>
          {contactsSectionExpanded ? '▼' : '▶'}
        </span>
      </div>

      {contactsSectionExpanded && (
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          {/* Procedure first — it governs the contacts below. */}
          {editingProcedure ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#2F3941', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                Escalation Procedure
              </div>
              <textarea
                value={procedureDraft}
                onChange={(e) => setProcedureDraft(e.target.value)}
                rows={8}
                placeholder={'e.g.\n\nP1 & P2 (incl. after hours):\n- Call the On Call engineer FIRST\n- Notify CSM before escalating\n- Join the critical bridge within 15 min of acknowledging\n\nUse the contacts below ONLY if On Call is unreachable.'}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: 8,
                  border: '1px solid #D8DCDE', borderRadius: 6,
                  fontSize: 11, lineHeight: 1.5, resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button onClick={cancelEditProcedure} style={ghostBtn('#68737D')}>Cancel</button>
                <button
                  onClick={saveProcedure}
                  style={{ padding: '4px 10px', fontSize: 11, backgroundColor: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  Save Procedure
                </button>
              </div>
            </div>
          ) : procedure ? (
            <div style={{
              border: '1px solid #F79A0A',
              backgroundColor: '#FFFDF5',
              borderRadius: 6,
              padding: '10px 12px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: '#B54708',
                  textTransform: 'uppercase', letterSpacing: '0.3px', flex: 1
                }}>
                  Escalation Procedure — read first
                </span>
                <button onClick={startEditProcedure} style={ghostBtn('#1F73B7')}>Edit</button>
              </div>
              <div style={{
                fontSize: 11, color: '#2F3941', lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word'
              }}>
                {procedure}
              </div>
            </div>
          ) : (
            <div style={{
              fontSize: 11, color: '#68737D',
              backgroundColor: '#F8F9FA', border: '1px dashed #D8DCDE',
              borderRadius: 6, padding: '8px 10px',
              display: 'flex', alignItems: 'center', gap: 8
            }}>
              <span style={{ flex: 1 }}>
                No escalation procedure on file. Contacts alone may not tell an agent
                who to call <em>first</em>.
              </span>
              <button onClick={startEditProcedure} style={ghostBtn('#1F73B7')}>Add</button>
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            paddingTop: 4, borderTop: '1px solid #F1F3F5'
          }}>
            <span style={{
              fontSize: 11, fontWeight: 600, color: '#2F3941', flex: 1,
              textTransform: 'uppercase', letterSpacing: '0.3px'
            }}>
              Contacts
            </span>
            <button
              onClick={() => {
                setShowAddContact(true);
                setEditingContact(null);
                setContactForm({ name: '', site: '', role: '', phone: '', email: '', note: '' });
              }}
              style={{ padding: '6px 12px', fontSize: 11, backgroundColor: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              + Add Contact
            </button>
          </div>

          {list.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#68737D', fontSize: 12, backgroundColor: '#F8F9FA', border: '1px dashed #D8DCDE', borderRadius: 6 }}>
              No escalation contacts on file for this customer
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {grouped.map((grp) => (
                <div key={grp.site} style={{ display: 'grid', gap: 6 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    color: grp.site === '__none__' ? '#68737D' : '#1F5FA8',
                    textTransform: 'uppercase', letterSpacing: '0.4px'
                  }}>
                    {grp.site === '__none__' ? 'All sites' : grp.site}
                  </div>

              {grp.items.map((c) => {
                const idx = list.indexOf(c);
                return (
                <div
                  key={c.id ?? idx}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #D8DCDE',
                    backgroundColor: '#FFFFFF',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.03)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 20, height: 20, borderRadius: 10, flexShrink: 0,
                      fontSize: 10, fontWeight: 700,
                      color: '#68737D',
                      backgroundColor: '#F1F3F5',
                      marginTop: 1
                    }}>
                      {idx + 1}
                    </span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#2F3941' }}>
                        {c.name}
                      </div>
                      {c.role && (
                        <div style={{ fontSize: 11, color: '#68737D', marginTop: 1 }}>
                          {c.role}
                        </div>
                      )}

                      <div style={{ display: 'grid', gap: 2, marginTop: 5 }}>
                        {c.phone && (
                          <a
                            href={`tel:${String(c.phone).replace(/[^\d+]/g, '')}`}
                            style={{ fontSize: 11, color: '#1F73B7', textDecoration: 'none', wordBreak: 'break-all' }}
                          >
                            {c.phone}
                          </a>
                        )}
                        {c.email && (
                          <a
                            href={`mailto:${c.email}`}
                            style={{ fontSize: 11, color: '#1F73B7', textDecoration: 'none', wordBreak: 'break-all' }}
                          >
                            {c.email}
                          </a>
                        )}
                      </div>

                      {c.note && (
                        <div style={{
                          fontSize: 11, color: '#2F3941',
                          backgroundColor: '#F8F9FA',
                          border: '1px solid #E4E6E8',
                          borderRadius: 4, padding: '4px 7px', marginTop: 6
                        }}>
                          {c.note}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                      <button
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0}
                        title="Move up"
                        style={{
                          border: '1px solid #D8DCDE', background: '#FFFFFF', borderRadius: 3,
                          width: 20, height: 16, fontSize: 8, lineHeight: 1, padding: 0,
                          cursor: idx === 0 ? 'default' : 'pointer',
                          color: idx === 0 ? '#D8DCDE' : '#68737D'
                        }}
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => move(idx, 1)}
                        disabled={idx === list.length - 1}
                        title="Move down"
                        style={{
                          border: '1px solid #D8DCDE', background: '#FFFFFF', borderRadius: 3,
                          width: 20, height: 16, fontSize: 8, lineHeight: 1, padding: 0,
                          cursor: idx === list.length - 1 ? 'default' : 'pointer',
                          color: idx === list.length - 1 ? '#D8DCDE' : '#68737D'
                        }}
                      >
                        ▼
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                    <button onClick={() => openEdit(c)} title="Edit contact" style={ghostBtn('#1F73B7')}>Edit</button>
                    <button onClick={() => askDelete(c)} title="Remove contact" style={ghostBtn('#CC3340')}>Remove</button>
                  </div>
                </div>
                );
              })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showDeleteConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2001
        }}>
          <div style={{
            backgroundColor: '#FFFFFF', borderRadius: '0', padding: '20px',
            width: '90%', maxWidth: '400px', boxShadow: '0 8px 24px rgba(0,0,0,0.2)'
          }}>
            <div style={{ fontSize: '14px', fontWeight: '600', color: '#CC3340', marginBottom: '12px' }}>
              Remove Contact?
            </div>
            <div style={{ fontSize: '12px', color: '#2F3941', marginBottom: '16px' }}>
              {toDelete?.name || 'This contact'} will be removed from this customer's
              escalation list.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={cancelDelete} style={{
                backgroundColor: 'transparent', border: '1px solid #D8DCDE', borderRadius: '4px',
                padding: '6px 12px', fontSize: '11px', color: '#68737D', cursor: 'pointer'
              }}>Cancel</button>
              <button onClick={confirmDelete} style={{
                backgroundColor: '#CC3340', color: '#FFFFFF', border: 'none', borderRadius: '4px',
                padding: '6px 12px', fontSize: '11px', cursor: 'pointer'
              }}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Escalation Contact Modal (Add / Edit) ----
function EscalationContactModal({
  open,
  onClose,
  contactForm,
  setContactForm,
  editingContact,
  escalationContacts,
  handleSaveEscalationContacts,
  setEditingContact
}) {
  const [error, setError] = React.useState('');

  React.useEffect(() => { if (open) setError(''); }, [open]);

  if (!open) return null;

  function onSubmit(e) {
    e.preventDefault();

    const name = (contactForm.name || '').trim();
    const phone = (contactForm.phone || '').trim();
    const email = (contactForm.email || '').trim();

    if (!name) {
      setError('A name is required.');
      return;
    }
    // A contact you can't reach isn't a contact.
    if (!phone && !email) {
      setError('Add a phone number or an email — otherwise there is no way to reach them.');
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('That email address does not look valid.');
      return;
    }

    const next = [...(escalationContacts || [])];

    if (editingContact) {
      const idx = next.findIndex(c => c === editingContact || (c?.id && c.id === editingContact.id));
      const base = idx >= 0 ? next[idx] : editingContact;
      const updated = {
        ...base,
        name,
        site: (contactForm.site || '').trim(),
        role: (contactForm.role || '').trim(),
        phone,
        email,
        note: (contactForm.note || '').trim()
      };
      if (idx >= 0) next[idx] = updated; else next.push(updated);
    } else {
      next.push({
        id: (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : (Date.now().toString(36) + Math.random().toString(36).slice(2))),
        name,
        site: (contactForm.site || '').trim(),
        role: (contactForm.role || '').trim(),
        phone,
        email,
        note: (contactForm.note || '').trim(),
        created_at: new Date().toISOString()
      });
    }

    handleSaveEscalationContacts(next);
    setEditingContact(null);
    onClose();
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
    }}>
      <div style={{ backgroundColor: '#FFFFFF', borderRadius: 8, width: 'min(560px, 92vw)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #D8DCDE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, color: '#2F3941' }}>
            {editingContact ? 'Edit Contact' : 'Add Escalation Contact'}
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <form onSubmit={onSubmit} style={{ padding: 16, display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Name
            <input
              value={contactForm.name}
              onChange={(e) => { setContactForm({ ...contactForm, name: e.target.value }); setError(''); }}
              required
              placeholder="e.g. Maria Chen"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12 }}
            />
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Site / region
            <input
              value={contactForm.site}
              onChange={(e) => setContactForm({ ...contactForm, site: e.target.value })}
              placeholder="e.g. BIDMC (Boston), Exeter Hospital"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              Contacts are grouped under this label. Leave blank if they cover all sites.
            </div>
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Role
            <input
              value={contactForm.role}
              onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })}
              placeholder="e.g. IT Director"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12 }}
            />
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Phone
            <input
              type="tel"
              value={contactForm.phone}
              onChange={(e) => { setContactForm({ ...contactForm, phone: e.target.value }); setError(''); }}
              placeholder="e.g. +1 555-0142"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12 }}
            />
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Email
            <input
              type="email"
              value={contactForm.email}
              onChange={(e) => { setContactForm({ ...contactForm, email: e.target.value }); setError(''); }}
              placeholder="e.g. maria.chen@customer.com"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>
              Phone or email — at least one is needed.
            </div>
          </label>

          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Notes
            <textarea
              value={contactForm.note}
              onChange={(e) => setContactForm({ ...contactForm, note: e.target.value })}
              rows={2}
              placeholder="e.g. Prefers text after hours. Do not call before 8am ET."
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, resize: 'vertical', fontSize: 12 }}
            />
          </label>

          {error && (
            <div style={{
              fontSize: 11, color: '#CC3340', backgroundColor: '#FBEAEA',
              border: '1px solid #CC3340', borderRadius: 6, padding: '6px 10px'
            }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: '#68737D' }}>
            New contacts are added to the end of the list. Reorder them with the arrows.
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #D8DCDE', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" style={{ background: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>
              {editingContact ? 'Save Changes' : 'Add Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Fancy Known Issues Card (Injected) ----
function KnownIssuesCard({
  knownIssues,
  setKnownIssues,
  knownIssuesSectionExpanded,
  setKnownIssuesSectionExpanded,
  setShowAddIssue,
  setEditingIssue,
  setIssueForm,
  handleSaveKnownIssues
}) {
  const [statusFilter, setStatusFilter] = React.useState('all');     // 'all' | 'active' | 'monitoring' | 'resolved' | 'ignored'
  const [severityFilter, setSeverityFilter] = React.useState('all'); // 'all' | 'high' | 'medium' | 'low'
  const [query, setQuery] = React.useState('');
  const [showDeleteIssueConfirm, setShowDeleteIssueConfirm] = React.useState(false);
  const [issueToDelete, setIssueToDelete] = React.useState(null);

  const STATUS_ORDER = { active: 0, monitoring: 1, resolved: 2, ignored: 3 };
  const SEV_ORDER    = { high: 0, medium: 1, low: 2 };

  const toneFor = (status) => ({
    active:      { fg: '#B54708', bg: '#FFF4CC' },
    monitoring:  { fg: '#1F73B7', bg: '#E8F5F8' },
    resolved:    { fg: '#2E7D0F', bg: '#E8F5E8' },
    ignored:     { fg: '#68737D', bg: '#F8F9FA' }
  }[status] || { fg: '#68737D', bg: '#F8F9FA' });

  const sevTone = (sev) => ({
    high:   { fg: '#CC3340', bg: '#FBEAEA', bar: '#CC3340' },
    medium: { fg: '#F79A0A', bg: '#FFF4CC', bar: '#F79A0A' },
    low:    { fg: '#2E7D0F', bg: '#E8F5E8', bar: '#2E7D0F' }
  }[sev] || { fg: '#68737D', bg: '#F8F9FA', bar: '#D8DCDE' });

  const filtered = React.useMemo(() => {
    return (knownIssues || [])
      .filter(i => statusFilter === 'all' ? true : i.status === statusFilter)
      .filter(i => severityFilter === 'all' ? true : i.severity === severityFilter)
      .filter(i => {
        if (!query.trim()) return true;
        const hay = `${i.title ?? ''} ${i.description ?? ''}`.toLowerCase();
        return hay.includes(query.toLowerCase());
      })
      .sort((a, b) => {
        const sA = STATUS_ORDER[a.status] ?? 99;
        const sB = STATUS_ORDER[b.status] ?? 99;
        if (sA !== sB) return sA - sB;
        const vA = SEV_ORDER[a.severity] ?? 99;
        const vB = SEV_ORDER[b.severity] ?? 99;
        if (vA !== vB) return vA - vB;
        const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tB - tA; // newest first
      });
  }, [knownIssues, statusFilter, severityFilter, query]);

  const activeCount = (knownIssues || []).filter(i => i.status === 'active').length;

  function quickSetStatusAt(idx, newStatus) {
    const next = [...knownIssues];
    next[idx] = { ...next[idx], status: newStatus };
    handleSaveKnownIssues(next);
  }

  function quickRemoveAt(issueToRemove) {
  setIssueToDelete(issueToRemove);
  setShowDeleteIssueConfirm(true);
}

function confirmDeleteIssue() {
  if (!issueToDelete) return;
  const next = knownIssues.filter(issue => issue !== issueToDelete);
  handleSaveKnownIssues(next);
  setShowDeleteIssueConfirm(false);
  setIssueToDelete(null);
}

function cancelDeleteIssue() {
  setShowDeleteIssueConfirm(false);
  setIssueToDelete(null);
}

  function quickEditAt(filteredIndex) {
    const issue = filtered[filteredIndex];
    const originalIndex = knownIssues.findIndex(
      i => i === issue || i.id === issue?.id || i.title === issue?.title
    );
    const useIndex = originalIndex >= 0 ? originalIndex : filteredIndex;
    const useIssue = knownIssues[useIndex] || issue;

    setEditingIssue(useIssue);
    setIssueForm({
      title: useIssue.title || '',
      description: useIssue.description || '',
      severity: useIssue.severity || 'low',
      status: useIssue.status || 'active'
    });
    setShowAddIssue(true);
  }

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      marginBottom: '0px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)', width: '100%', boxSizing: 'border-box', overflow: 'hidden', wordBreak: 'break-word'
    }}>
      <div
        onClick={() => setKnownIssuesSectionExpanded(!knownIssuesSectionExpanded)}
        style={{
          cursor: 'pointer',
          padding: "10px 12px",
          minHeight: '35px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: knownIssuesSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <path d="m9 14 2 2 4-4" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#2F3941' }}>
            Known Issues ({activeCount} active)
          </span>
        </div>
        <span style={{ color: '#68737D', fontSize: 12 }}>
          {knownIssuesSectionExpanded ? '▼' : '▶'}
        </span>
      </div>

      {knownIssuesSectionExpanded && (
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 12 }}>
  <input
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    placeholder="Search issues…"
    style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, boxSizing: 'border-box' }}
  />
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center' }}>
    <select
      value={statusFilter}
      onChange={(e) => setStatusFilter(e.target.value)}
      style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', minWidth: 0 }}
      title="Filter by status"
    >
      <option value="all">All statuses</option>
      <option value="active">Active</option>
      <option value="monitoring">Monitoring</option>
      <option value="resolved">Resolved</option>
      <option value="ignored">Ignored</option>
    </select>
    <select
      value={severityFilter}
      onChange={(e) => setSeverityFilter(e.target.value)}
      style={{ padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', minWidth: 0 }}
      title="Filter by severity"
    >
      <option value="all">All severities</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
    <button
      onClick={() => {
        setShowAddIssue(true);
        setEditingIssue(null);
        setIssueForm({ title: '', description: '', severity: 'low', status: 'active' });
      }}
      style={{ padding: '6px 12px', fontSize: 11, backgroundColor: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      + Report Issue
    </button>
  </div>
</div>

          {filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#68737D', fontSize: 12, backgroundColor: '#F8F9FA', border: '1px dashed #D8DCDE', borderRadius: 6 }}>
              No issues match your filters
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
              {filtered.map((issue, fIdx) => {
                const sev = sevTone(issue.severity);
                const st  = toneFor(issue.status);
                const isDim = issue.status === 'resolved' || issue.status === 'ignored';
                const originalIndex = knownIssues.findIndex(i =>
                  i === issue || i.id === issue?.id || i.title === issue?.title
                );
                const i = originalIndex >= 0 ? originalIndex : fIdx;

                return (
                  <div
                    key={issue.id ?? `${issue.title}-${i}`}
                    style={{
                      display: 'grid',
                      gap: 6,
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid #D8DCDE',
                      backgroundColor: '#FFFFFF',
                      opacity: isDim ? 0.8 : 1,
                      boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                      position: 'relative'
                    }}
                  >
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
                      backgroundColor: sev.bar, borderTopLeftRadius: 8, borderBottomLeftRadius: 8
                    }} />

                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', paddingLeft: 6, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: '#2F3941', flex: 1, textDecoration: isDim ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {issue.title || 'Untitled issue'}
                    </div>
                    <div style={{ fontSize: 10, color: '#68737D', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {issue.created_at ? new Date(issue.created_at).toLocaleDateString() : ''}
                      </div>
                    </div>

                    {issue.description && (
                      <div style={{ color: '#68737D', fontSize: 12, paddingLeft: 6, overflow: 'hidden', wordBreak: 'break-word' }}>
                    {issue.description}
                  </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 6, gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: st.fg, backgroundColor: st.bg, padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase' }}>
                          {issue.status || 'unknown'}
                        </span>
                        <span style={{ fontSize: 10, fontWeight: 600, color: sev.fg, backgroundColor: sev.bg, padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase' }}>
                          {issue.severity || 'n/a'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button onClick={() => quickEditAt(fIdx)} title="Edit" style={ghostBtn('#1F73B7')}>Edit</button>
                        {issue.status === 'resolved' ? (
                          <button onClick={() => quickSetStatusAt(i, 'active')} title="Reopen" style={ghostBtn('#B54708')}>Reopen</button>
                        ) : (
                          <button onClick={() => quickSetStatusAt(i, 'resolved')} title="Mark Resolved" style={ghostBtn('#2E7D0F')}>Resolve</button>
                        )}
                        <button onClick={() => quickRemoveAt(issue)} title="Remove" style={ghostBtn('#CC3340')}>Remove</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Delete Issue Confirmation Modal - ADD THIS ENTIRE BLOCK HERE */}
      {showDeleteIssueConfirm && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2001
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '0',
            padding: '20px',
            width: '90%',
            maxWidth: '400px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)'
          }}>
            <div style={{
              fontSize: '14px',
              fontWeight: '600',
              color: '#CC3340',
              marginBottom: '12px'
            }}>
              Remove Issue?
            </div>
            <div style={{
              fontSize: '12px',
              color: '#2F3941',
              marginBottom: '16px'
            }}>
              Are you sure you want to remove "{issueToDelete?.title || 'this issue'}" from Known Issues?
            </div>
            <div style={{
              display: 'flex',
              gap: '8px',
              justifyContent: 'flex-end'
            }}>
              <button
                onClick={cancelDeleteIssue}
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  color: '#68737D',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteIssue}
                style={{
                  backgroundColor: '#CC3340',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
}

// ---- Known Issue Modal (Add/Edit) ----
function KnownIssueModal({
  open,
  onClose,
  issueForm,
  setIssueForm,
  editingIssue,
  knownIssues,
  handleSaveKnownIssues,
  setEditingIssue
}) {
  if (!open) return null;

  function onSubmit(e) {
    e.preventDefault();
    const next = [...(knownIssues || [])];
    if (editingIssue) {
      const idx = next.findIndex(i => i === editingIssue || i?.id === editingIssue?.id || i?.title === editingIssue?.title);
      const base = idx >= 0 ? next[idx] : editingIssue;
      const updated = { ...base, ...issueForm };
      if (!updated.created_at) updated.created_at = new Date().toISOString();
      if (idx >= 0) next[idx] = updated; else next.push(updated);
    } else {
      next.push({
        id: (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36)+Math.random().toString(36).slice(2))),
        title: issueForm.title || 'Untitled issue',
        description: issueForm.description || '',
        severity: issueForm.severity || 'low',
        status: issueForm.status || 'active',
        created_at: new Date().toISOString()
      });
    }
    handleSaveKnownIssues(next);
    setEditingIssue(null);
    onClose();
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
    }}>
      <div style={{ backgroundColor: '#FFFFFF', borderRadius: 8, width: 'min(560px, 92vw)', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #D8DCDE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, color: '#2F3941' }}>{editingIssue ? 'Edit Issue' : 'Add Issue'}</div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
        <form onSubmit={onSubmit} style={{ padding: 16, display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Title
            <input
              value={issueForm.title}
              onChange={(e) => setIssueForm({ ...issueForm, title: e.target.value })}
              required
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6 }}
            />
          </label>
          <label style={{ fontSize: 12, color: '#2F3941' }}>
            Description
            <textarea
              value={issueForm.description}
              onChange={(e) => setIssueForm({ ...issueForm, description: e.target.value })}
              rows={4}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6, resize: 'vertical' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: '#2F3941' }}>
              Severity
              <select
                value={issueForm.severity}
                onChange={(e) => setIssueForm({ ...issueForm, severity: e.target.value })}
                style={{ display: 'block', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6 }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: '#2F3941' }}>
              Status
              <select
                value={issueForm.status}
                onChange={(e) => setIssueForm({ ...issueForm, status: e.target.value })}
                style={{ display: 'block', padding: '8px', marginTop: 4, border: '1px solid #D8DCDE', borderRadius: 6 }}
              >
                <option value="active">Active</option>
                <option value="monitoring">Monitoring</option>
                <option value="resolved">Resolved</option>
                <option value="ignored">Ignored</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', border: '1px solid #D8DCDE', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>Cancel</button>
            <button type="submit" style={{ background: '#1F73B7', color: '#FFFFFF', border: 'none', borderRadius: 6, padding: '8px 12px', cursor: 'pointer' }}>{editingIssue ? 'Save Changes' : 'Add Issue'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Small helper for consistent ghost buttons
function ghostBtn(color) {
  return {
    background: 'transparent',
    border: '1px solid #D8DCDE',
    color,
    cursor: 'pointer',
    fontSize: 10,
    padding: '4px 8px',
    borderRadius: 4,
    minWidth: 0,
    flexShrink: 1
  };
}


// Enhanced OPS Calendar Component with PTO support and full features
function OPSCalendarComponent({ requester, assets, requesterOrg }) {
  const [events, setEvents] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewMode, setViewMode] = useState('day');
  const [selectedCalendar, setSelectedCalendar] = useState('ops'); // Add calendar selector
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [showEditEvent, setShowEditEvent] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [calendarConfig, setCalendarConfig] = useState({
    opsCalendarId: 'primary',
    ptoCalendarId: null
  });
  const [eventForm, setEventForm] = useState({
    summary: '',
    description: '',
    startDateTime: new Date().toISOString().slice(0, 16),
    endDateTime: new Date(Date.now() + 3600000).toISOString().slice(0, 16),
    eventType: 'meeting',
    location: '',
    ticketId: '',
    assetIds: []
  });
  const [showDeleteEventConfirm, setShowDeleteEventConfirm] = useState(false);
  const [eventToDelete, setEventToDelete] = useState(null);
  const [showExpandedView, setShowExpandedView] = useState(false);

  // Fetch calendar configuration
  useEffect(() => {
    fetchCalendarConfig();
  }, []);

  async function fetchCalendarConfig() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/config`);
    if (response.ok) {
      const config = await response.json();
      
      const newConfig = {
        opsCalendarId: config.calendarId || 'primary',
        ptoCalendarId: config.ptoCalendarId
      };
      
      setCalendarConfig(newConfig);
      
      console.log('[Asset Manager] Calendar config loaded:', {
        ops: config.calendarId,
        pto: config.ptoCalendarId
      });
      
      // Return the config so other functions can use it immediately
      return newConfig;
    }
  } catch (err) {
    console.error('[Asset Manager] Error fetching calendar config:', err);
    return null;
  }
}

  // Fetch events when calendar, date, or view mode changes
  useEffect(() => {
    fetchEvents();
  }, [selectedDate, selectedCalendar, viewMode]);

  // Close expanded view on ESC key
  useEffect(() => {
    const handleEsc = (event) => {
      if (event.key === 'Escape' && showExpandedView) {
        setShowExpandedView(false);
        setViewMode('list');
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [showExpandedView]);

  async function fetchEvents() {
  console.log('[fetchEvents] Starting fetch...', { viewMode, selectedDate, selectedCalendar });
  setLoading(true);
  setError(null);
  
  try {
    let currentConfig = calendarConfig;
    
    // If config isn't ready, fetch it and get the fresh data
    if (!currentConfig.opsCalendarId || currentConfig.opsCalendarId === 'primary' || 
        (selectedCalendar === 'pto' && !currentConfig.ptoCalendarId)) {
      console.log('[Calendar] Config not ready, fetching...');
      const freshConfig = await fetchCalendarConfig();
      if (freshConfig) {
        currentConfig = freshConfig; // Use fresh config immediately
      }
    }
    
    // Get the appropriate calendar ID from current config
    const calendarId = selectedCalendar === 'pto' 
      ? currentConfig.ptoCalendarId 
      : currentConfig.opsCalendarId;
    
    if (!calendarId || calendarId === 'primary') {
      console.error(`[Calendar] No proper calendar ID configured for: ${selectedCalendar}, got:`, calendarId);
      setEvents([]);
      setLoading(false);
      return;
    }

    console.log('[Calendar] Fetching events for:', selectedCalendar, 'with ID:', calendarId);

    // Get date boundaries based on view mode
    let timeMin, timeMax;
    if (viewMode === 'day') {
      timeMin = new Date(selectedDate);
      timeMin.setHours(0, 0, 0, 0);
      timeMax = new Date(selectedDate);
      timeMax.setHours(23, 59, 59, 999);
    } else if (viewMode === 'week') {
      const startOfWeek = new Date(selectedDate);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(endOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);
      timeMin = startOfWeek;
      timeMax = endOfWeek;
    } else {
      // Month view or list view
      timeMin = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
      timeMax = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0, 23, 59, 59);
    }
    
    const startOfMonth = timeMin;
    const endOfMonth = timeMax;
    
    const url = `${BACKEND_BASE_URL}/api/ops-calendar/events?` + 
      `calendarId=${encodeURIComponent(calendarId)}&` +
      `timeMin=${startOfMonth.toISOString()}&` +
      `timeMax=${endOfMonth.toISOString()}&` +
      `maxResults=250`;
    
    const response = await fetch(url);
    
    if (response.ok) {
      const data = await response.json();
      console.log('[fetchEvents] API response:', data);
      // Filter to ensure only events in selected month
      const monthEvents = (data.events || []).filter(event => {
        const eventDate = parseEventDate(event);
        return eventDate.getMonth() === selectedDate.getMonth() && 
               eventDate.getFullYear() === selectedDate.getFullYear();
      });
      setEvents(monthEvents);
      console.log('[Calendar] Events set:', monthEvents.length, 'events');
      
      console.log('[Calendar] Successfully loaded', monthEvents.length, 'events from', selectedCalendar, 'calendar');
    }
  } catch (err) {
    console.error('[Calendar] Error fetching events:', err);
    setError(`Error: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

  // Open edit modal
  function handleEditEvent(event) {
    setEditingEvent(event);
    setEventForm({
      summary: event.summary || '',
      description: event.description?.split('\n[')[0] || '', // Remove metadata
      startDateTime: event.start?.dateTime ? 
        new Date(event.start.dateTime).toISOString().slice(0, 16) : 
        new Date().toISOString().slice(0, 16),
      endDateTime: event.end?.dateTime ? 
        new Date(event.end.dateTime).toISOString().slice(0, 16) : 
        new Date(Date.now() + 3600000).toISOString().slice(0, 16),
      eventType: event.eventType || 'meeting',
      location: event.location || '',
      ticketId: event.ticketId || '',
      assetIds: event.assetIds || []
    });
    setShowEditEvent(true);
  }

  // Save edited event
  async function handleSaveEdit() {
    if (!editingEvent) return;
    
    try {
      const calendarId = selectedCalendar === 'pto' 
        ? calendarConfig.ptoCalendarId 
        : calendarConfig.opsCalendarId;

      const payload = {
        summary: eventForm.summary || 'Updated Event',
        description: eventForm.description,
        location: eventForm.location,
        startDateTime: new Date(eventForm.startDateTime).toISOString(),
        endDateTime: new Date(eventForm.endDateTime).toISOString(),
        eventType: eventForm.eventType,
        ticketId: eventForm.ticketId,
        assetIds: eventForm.assetIds,
        calendarId: calendarId
      };

      const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/events/${editingEvent.id}?calendarId=${encodeURIComponent(calendarId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        await fetchEvents();
        setShowEditEvent(false);
        setEditingEvent(null);
        resetEventForm();
        
        if (window.ZAFClient) {
          const client = window.ZAFClient.init();
          await client.invoke('notify', 'Event updated successfully!', 'notice');
        }
      }
    } catch (err) {
      console.error('[Calendar] Error updating event:', err);
    }
  }

  // Create new event
  async function handleCreateEvent() {
    try {
      const calendarId = selectedCalendar === 'pto' 
        ? calendarConfig.ptoCalendarId 
        : calendarConfig.opsCalendarId;

      const payload = {
        summary: eventForm.summary || `New ${selectedCalendar.toUpperCase()} Event`,
        description: eventForm.description,
        location: eventForm.location,
        startDateTime: new Date(eventForm.startDateTime).toISOString(),
        endDateTime: new Date(eventForm.endDateTime).toISOString(),
        eventType: eventForm.eventType,
        ticketId: eventForm.ticketId,
        assetIds: eventForm.assetIds,
        calendarId: calendarId
      };

      const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/events?calendarId=${encodeURIComponent(calendarId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (response.ok) {
        await fetchEvents();
        setShowCreateEvent(false);
        resetEventForm();
        
        if (window.ZAFClient) {
          const client = window.ZAFClient.init();
          await client.invoke('notify', 'Calendar event created successfully!', 'notice');
        }
      }
    } catch (err) {
      console.error('[Calendar] Error creating event:', err);
    }
  }

  // Delete event
  function handleDeleteEvent(event) {
    setEventToDelete(event);
    setShowDeleteEventConfirm(true);
  }

  async function confirmDeleteEvent() {
    if (!eventToDelete) return;
    
    try {
      const calendarId = selectedCalendar === 'pto' 
        ? calendarConfig.ptoCalendarId 
        : calendarConfig.opsCalendarId;

      const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/events/${eventToDelete.id}?calendarId=${encodeURIComponent(calendarId)}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        await fetchEvents();
        if (window.ZAFClient) {
          const client = window.ZAFClient.init();
          await client.invoke('notify', 'Event deleted successfully', 'notice');
        }
      }
    } catch (err) {
      console.error('[Calendar] Error deleting event:', err);
    }
    
    setShowDeleteEventConfirm(false);
    setEventToDelete(null);
  }

  function cancelDeleteEvent() {
    setShowDeleteEventConfirm(false);
    setEventToDelete(null);
  }

// Day view - shows all events for a single day
  function renderDayView() {
    const dayEvents = events.filter(event => {
      const eventDate = parseEventDate(event);
      return eventDate.toDateString() === selectedDate.toDateString();
    });

    const hours = Array.from({ length: 24 }, (_, i) => i);

    return (
      <div style={{ marginTop: '12px', maxHeight: '500px', overflowY: 'auto' }}>
        {hours.map(hour => {
          const hourEvents = dayEvents.filter(event => {
            const eventStart = new Date(event.start?.dateTime || event.start?.date);
            return eventStart.getHours() === hour;
          });

          return (
            <div key={hour} style={{
              display: 'flex',
              borderBottom: '1px solid #E0E0E0',
              minHeight: '50px'
            }}>
              <div style={{
                width: '60px',
                padding: '8px',
                fontSize: '10px',
                fontWeight: '600',
                color: '#68737D',
                backgroundColor: '#F8F9FA',
                borderRight: '1px solid #E0E0E0'
              }}>
                {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
              </div>
              <div style={{ flex: 1, padding: '4px' }}>
                {hourEvents.map((event, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleEditEvent(event)}
                    style={{
                      padding: '6px 8px',
                      marginBottom: '4px',
                      backgroundColor: getEventColor(event.eventType),
                      borderLeft: `3px solid ${getEventColor(event.eventType).replace('20', '')}`,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '11px'
                    }}
                  >
                    <div style={{ fontWeight: '600', marginBottom: '2px' }}>
                      {formatEventTime(event)} - {event.summary}
                    </div>
                    {event.location && (
                      <div style={{ fontSize: '10px', color: '#68737D' }}>
                        📍 {event.location}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Week view - shows 7 days as vertical list
  function renderWeekView() {
    const startOfWeek = new Date(selectedDate);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(startOfWeek);
      day.setDate(day.getDate() + i);
      return day;
    });

    return (
      <div style={{ marginTop: '12px' }}>
        {weekDays.map((day, idx) => {
          const dayEvents = events.filter(event => {
            const eventDate = parseEventDate(event);
            return eventDate.toDateString() === day.toDateString();
          });

          const isToday = day.toDateString() === new Date().toDateString();

          return (
            <div key={idx} style={{
              marginBottom: '12px',
              padding: '12px',
              backgroundColor: isToday ? '#E8F5E8' : '#F8F9FA',
              borderRadius: '6px',
              border: isToday ? '2px solid #1F73B7' : '1px solid #D8DCDE'
            }}>
              <div style={{
                fontSize: '13px',
                fontWeight: '600',
                marginBottom: '8px',
                color: isToday ? '#1F73B7' : '#2F3941',
                borderBottom: '1px solid #D8DCDE',
                paddingBottom: '8px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <div>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][idx]} - {day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                {dayEvents.length > 0 && (
                  <span style={{ 
                    fontSize: '11px', 
                    color: '#68737D',
                    fontWeight: 'normal'
                  }}>
                    {dayEvents.length} event{dayEvents.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              
              {dayEvents.length === 0 ? (
                <div style={{ 
                  padding: '12px', 
                  textAlign: 'center', 
                  color: '#68737D',
                  fontSize: '11px'
                }}>
                  No events scheduled
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {dayEvents.map((event, eventIdx) => (
                    <div
                      key={eventIdx}
                      onClick={() => handleEditEvent(event)}
                      style={{
                        padding: '8px',
                        backgroundColor: getEventColor(event.eventType),
                        borderRadius: '4px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        borderLeft: `3px solid ${getEventColor(event.eventType).replace('20', '')}`,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start'
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: '600', marginBottom: '2px' }}>
                          {formatEventTime(event)} - {event.summary}
                        </div>
                        {event.location && (
                          <div style={{ fontSize: '10px', color: '#68737D' }}>
                            📍 {event.location}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditEvent(event);
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid #D8DCDE',
                            color: '#1F73B7',
                            cursor: 'pointer',
                            fontSize: '9px',
                            padding: '2px 6px',
                            borderRadius: '3px'
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteEvent(event);
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid #D8DCDE',
                            color: '#CC3340',
                            cursor: 'pointer',
                            fontSize: '9px',
                            padding: '2px 6px',
                            borderRadius: '3px'
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function resetEventForm() {
    setEventForm({
      summary: '',
      description: '',
      startDateTime: new Date().toISOString().slice(0, 16),
      endDateTime: new Date(Date.now() + 3600000).toISOString().slice(0, 16),
      eventType: 'meeting',
      location: '',
      ticketId: '',
      assetIds: []
    });
  }

  // Filter events
  const filteredEvents = events.filter(event => {
    if (filter === 'all') return true;
    return event.eventType === filter;
  });

  // Month view - shows all days in month as vertical list
  function renderMonthView() {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    
    const monthDays = [];
    for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
      monthDays.push(new Date(d));
    }

    return (
      <div style={{ marginTop: '12px' }}>
        {monthDays.map((day, idx) => {
          const dayEvents = events.filter(event => {
            const eventDate = parseEventDate(event);
            return eventDate.toDateString() === day.toDateString();
          });

          const isToday = day.toDateString() === new Date().toDateString();

          // Only show days with events or today
          if (dayEvents.length === 0 && !isToday) {
            return null;
          }

          return (
            <div key={idx} style={{
              marginBottom: '8px',
              padding: '10px',
              backgroundColor: isToday ? '#E8F5E8' : '#F8F9FA',
              borderRadius: '6px',
              border: isToday ? '2px solid #1F73B7' : '1px solid #D8DCDE'
            }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '600',
                marginBottom: '6px',
                color: isToday ? '#1F73B7' : '#2F3941',
                borderBottom: '1px solid #D8DCDE',
                paddingBottom: '6px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <div>
                  {day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
                {dayEvents.length > 0 && (
                  <span style={{ 
                    fontSize: '10px', 
                    color: '#68737D',
                    fontWeight: 'normal'
                  }}>
                    {dayEvents.length} event{dayEvents.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              
              {dayEvents.length === 0 ? (
                <div style={{ 
                  padding: '8px', 
                  textAlign: 'center', 
                  color: '#68737D',
                  fontSize: '10px'
                }}>
                  No events scheduled
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {dayEvents.map((event, eventIdx) => (
                    <div
                      key={eventIdx}
                      onClick={() => handleEditEvent(event)}
                      style={{
                        padding: '6px 8px',
                        backgroundColor: getEventColor(event.eventType),
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        borderLeft: `3px solid ${getEventColor(event.eventType).replace('20', '')}`,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start'
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: '600', marginBottom: '2px' }}>
                          {formatEventTime(event)} - {event.summary}
                        </div>
                        {event.location && (
                          <div style={{ fontSize: '9px', color: '#68737D' }}>
                            📍 {event.location}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditEvent(event);
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid #D8DCDE',
                            color: '#1F73B7',
                            cursor: 'pointer',
                            fontSize: '9px',
                            padding: '2px 6px',
                            borderRadius: '3px'
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteEvent(event);
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid #D8DCDE',
                            color: '#CC3340',
                            cursor: 'pointer',
                            fontSize: '9px',
                            padding: '2px 6px',
                            borderRadius: '3px'
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function getEventColor(type) {
    const colors = {
      meeting: '#4285f4',
      maintenance: '#ea4335',
      deployment: '#fbbc04',
      training: '#34a853',
      outage: '#ff6d00',
      other: '#9e9e9e'
    };
    return colors[type] ? `${colors[type]}20` : '#F8F9FA';
  }

// Helper to parse event dates correctly (handles timezone issues with all-day events)
  function parseEventDate(event) {
    if (!event.start) return new Date();
    
    // All-day events come as event.start.date (just date, no time)
    if (event.start.date && !event.start.dateTime) {
      // Parse as local date without timezone conversion
      const dateStr = event.start.date;
      const [year, month, day] = dateStr.split('-').map(Number);
      return new Date(year, month - 1, day); // month is 0-indexed
    }
    
    // Timed events come as event.start.dateTime
    return new Date(event.start.dateTime || event.start.date);
  }
  
  function formatEventTime(event) {
    if (!event.start) return 'No time';
    if (event.isAllDay) return 'All day';
    try {
      const start = new Date(event.start?.dateTime || event.start?.date);
      return start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return 'Time unavailable';
    }
  }

  return (
    <div>
      {/* Date Navigation */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '12px',
        padding: '8px 12px',
        backgroundColor: '#F8F9FA',
        borderRadius: '6px',
        border: '1px solid #D8DCDE'
      }}>
        <button
          onClick={() => {
            const newDate = new Date(selectedDate);
            if (viewMode === 'day') {
              newDate.setDate(newDate.getDate() - 1);
            } else if (viewMode === 'week') {
              newDate.setDate(newDate.getDate() - 7);
            } else {
              newDate.setMonth(newDate.getMonth() - 1);
            }
            setSelectedDate(newDate);
          }}
          style={{
            padding: '6px 12px',
            fontSize: '14px',
            border: '1px solid #D8DCDE',
            borderRadius: '4px',
            backgroundColor: '#FFFFFF',
            color: '#2F3941',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          ◀
        </button>
        
        <div style={{
            flex: 1,
            textAlign: 'center',
            fontSize: '14px',
            fontWeight: '600',
            color: '#2F3941',
            padding: '0 16px'
          }}>
            {viewMode === 'day' && selectedDate.toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric', 
              year: 'numeric' 
            })}
            {viewMode === 'week' && `Week of ${selectedDate.toLocaleDateString('en-US', { 
              month: 'short', 
              day: 'numeric', 
              year: 'numeric' 
            })}`}
            {viewMode === 'month' && selectedDate.toLocaleDateString('en-US', { 
              month: 'long', 
              year: 'numeric' 
            })}
          </div>
        
        <button
          onClick={() => {
            const newDate = new Date(selectedDate);
            if (viewMode === 'day') {
              newDate.setDate(newDate.getDate() + 1);
            } else if (viewMode === 'week') {
              newDate.setDate(newDate.getDate() + 7);
            } else {
              newDate.setMonth(newDate.getMonth() + 1);
            }
            setSelectedDate(newDate);
          }}
          style={{
            padding: '6px 12px',
            fontSize: '14px',
            border: '1px solid #D8DCDE',
            borderRadius: '4px',
            backgroundColor: '#FFFFFF',
            color: '#2F3941',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          ▶
        </button>
        
        <button
          onClick={() => setSelectedDate(new Date())}
          style={{
            padding: '6px 12px',
            fontSize: '11px',
            border: '1px solid #1F73B7',
            borderRadius: '4px',
            backgroundColor: '#FFFFFF',
            color: '#1F73B7',
            cursor: 'pointer',
            fontWeight: '600',
            marginLeft: '8px'
          }}
        >
          Today
        </button>
      </div>
      
      {/* Header with calendar selector and controls */}
      <div style={{
        marginBottom: '12px'
      }}>

        {/* First row: Calendar selector and view buttons */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '6px',
          flexWrap: 'wrap'
        }}>
          {/* Calendar selector */}
          <select
            value={selectedCalendar}
            onChange={(e) => setSelectedCalendar(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              backgroundColor: '#FFFFFF',
              color: '#2F3941',
              cursor: 'pointer',
              fontWeight: '600'
            }}
          >
            <option value="ops">OPS Calendar</option>
            <option value="pto">intlx Calendar</option>
          </select>
          
          {/* View mode buttons */}
          {['day', 'week', 'month'].map(mode => (
            <button
              key={mode}
              onClick={() => {
                console.log('Setting view mode to:', mode);
                setViewMode(mode);
              }}
              style={{
                padding: '4px 8px',
                fontSize: '10px',
                border: '1px solid #D8DCDE',
                borderRadius: '4px',
                backgroundColor: viewMode === mode ? '#1F73B7' : 'transparent',
                color: viewMode === mode ? '#FFFFFF' : '#68737D',
                cursor: 'pointer',
                textTransform: 'capitalize'
              }}
            >
              {mode}
            </button>
          ))}
        </div>
        
        {/* Second row: Action buttons */}
        <div style={{
          display: 'flex',
          gap: '6px'
        }}>
          <button
            onClick={() => setShowCreateEvent(true)}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '10px',
              backgroundColor: '#1F73B7',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '600'
            }}
          >
            + New Event
          </button>
          
          <button
            onClick={fetchEvents}
            style={{
              padding: '6px 8px',
              fontSize: '10px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              backgroundColor: '#FFFFFF',
              color: '#68737D',
              cursor: 'pointer'
            }}
            title="Refresh events"
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* View content */}
      {console.log('DEBUG:', { loading, viewMode, eventsCount: events.length })}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px', color: '#68737D', fontSize: '12px' }}>
         Loading {selectedCalendar === 'ops' ? 'OPS' : 'intlx'} calendar events...
        </div>
      ) : (() => {
        console.log('Rendering view. viewMode:', viewMode, 'events:', events.length);
        return viewMode === 'day' ? (
          renderDayView()
        ) : viewMode === 'week' ? (
          renderWeekView()
        ) : viewMode === 'month' ? (
          renderMonthView()
        ) : (
          <div style={{ padding: '20px', textAlign: 'center', color: '#68737D', fontSize: '12px' }}>
            Select a view mode to see events
          </div>
        );
      })()}

      {/* Create/Edit Event Modal - rest of the component stays the same */}
      {(showCreateEvent || showEditEvent) && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '0',
            padding: '16px',
            width: '90%',
            maxWidth: '400px',
            maxHeight: '70vh',
            overflowY: 'auto'
          }}>
            <h3 style={{ marginBottom: '0px', fontSize: '14px', marginTop: '0px' }}>
              {showEditEvent ? 'Edit Calendar Event' : `Create ${selectedCalendar.toUpperCase()} Calendar Event`}
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                placeholder="Event title"
                value={eventForm.summary}
                onChange={(e) => setEventForm({...eventForm, summary: e.target.value})}
                style={{
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px'
                }}
              />
              
              <div>
                <label style={{ fontSize: '11px', color: '#68737D', display: 'block', marginBottom: '4px' }}>Start</label>
                <input
                  type="datetime-local"
                  value={eventForm.startDateTime}
                  onChange={(e) => setEventForm({...eventForm, startDateTime: e.target.value})}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    border: '1px solid #D8DCDE',
                    borderRadius: '4px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              
              <div>
                <label style={{ fontSize: '11px', color: '#68737D', display: 'block', marginBottom: '4px' }}>End</label>
                <input
                  type="datetime-local"
                  value={eventForm.endDateTime}
                  onChange={(e) => setEventForm({...eventForm, endDateTime: e.target.value})}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '12px',
                    border: '1px solid #D8DCDE',
                    borderRadius: '4px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <input
                placeholder="Location (optional)"
                value={eventForm.location}
                onChange={(e) => setEventForm({...eventForm, location: e.target.value})}
                style={{
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px'
                }}
              />
              
              <textarea
                placeholder="Description"
                value={eventForm.description}
                onChange={(e) => setEventForm({...eventForm, description: e.target.value})}
                style={{
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  minHeight: '50px',
                  resize: 'vertical'
                }}
              />
              
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => {
                    setShowCreateEvent(false);
                    setShowEditEvent(false);
                    setEditingEvent(null);
                    resetEventForm();
                  }}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    border: '1px solid #D8DCDE',
                    borderRadius: '4px',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={showEditEvent ? handleSaveEdit : handleCreateEvent}
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: '#1F73B7',
                    color: '#FFFFFF',
                    cursor: 'pointer'
                  }}
                >
                  {showEditEvent ? 'Save Changes' : 'Create Event'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Event Confirmation Modal */}
      {showDeleteEventConfirm && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2001
        }}>
          <div style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '0',
            padding: '20px',
            width: '90%',
            maxWidth: '400px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)'
          }}>
            <h3 style={{ marginBottom: '0px', fontSize: '14px', color: '#CC3340' }}>
              Delete Calendar Event?
            </h3>
            <p style={{ fontSize: '12px', marginBottom: '16px' }}>
              Are you sure you want to delete "{eventToDelete?.summary || 'this event'}"?
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={cancelDeleteEvent}
                style={{
                  padding: '6px 12px',
                  fontSize: '11px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  backgroundColor: 'transparent',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteEvent}
                style={{
                  padding: '6px 12px',
                  fontSize: '11px',
                  border: 'none',
                  borderRadius: '4px',
                  backgroundColor: '#CC3340',
                  color: '#FFFFFF',
                  cursor: 'pointer'
                }}
              >
                Delete Event
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// EscalationCard Component — replaces the legacy Zendesk escalation macro.
function EscalationCard({
  escalationSectionExpanded,
  setEscalationSectionExpanded,
  ticketId,
  assigneeOptions,
  statusOptions,
  escalationForm,
  setEscalationForm,
  isEscalating,
  handleEscalate
}) {
  // Zendesk group ID for Escalations (renamed to "Advanced Services"). Gating on
  // the numeric ID means the rename doesn't affect this logic.
  const ESCALATIONS_GROUP_ID = 17378107578519;

  // --- Assignee combobox (searchable: groups pinned on top, engineers A–Z) ---
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const assigneeBoxRef = React.useRef(null);

  // Groups in the desired fixed order; fall back to alphabetical for any others.
  const GROUP_ORDER = ['DevOPS', 'Engineering', 'Escalations', 'Triage'];
  const orderedGroups = (assigneeOptions || []).slice().sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.name); const bi = GROUP_ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  // De-duplicate engineers across all groups, then sort A–Z by name.
  const engineerMap = {};
  (assigneeOptions || []).forEach(g => {
    (g.members || []).forEach(m => {
      if (m && m.id != null && !engineerMap[m.id]) engineerMap[m.id] = m;
    });
  });
  const uniqueEngineers = Object.values(engineerMap).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );

  // Apply the type-to-filter text to both lists.
  const q = assigneeQuery.trim().toLowerCase();
  const filteredGroups = q
    ? orderedGroups.filter(g => (g.name || '').toLowerCase().includes(q))
    : orderedGroups;
  const filteredEngineers = q
    ? uniqueEngineers.filter(m => (m.name || '').toLowerCase().includes(q))
    : uniqueEngineers;

  // Resolve the current selection to a display label for the input.
  const assigneeLabel = (() => {
    const v = escalationForm.assigneeValue;
    if (!v) return '';
    const [kind, id] = v.split(':');
    if (kind === 'group') {
      const g = (assigneeOptions || []).find(x => String(x.id) === id);
      return g ? `${g.name} (group)` : '';
    }
    if (kind === 'agent') {
      const m = engineerMap[id];
      return m ? m.name : '';
    }
    return '';
  })();

  const selectAssignee = (value) => {
    setEscalationForm({ ...escalationForm, assigneeValue: value });
    setAssigneeOpen(false);
    setAssigneeQuery('');
  };

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!assigneeOpen) return;
    const onDocClick = (e) => {
      if (assigneeBoxRef.current && !assigneeBoxRef.current.contains(e.target)) {
        setAssigneeOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [assigneeOpen]);


  const canSubmit = escalationForm.rejectMode
    ? (
        !!ticketId &&
        !isEscalating &&
        !!escalationForm.rejectReason &&
        !(escalationForm.rejectReason === 'Other' && !(escalationForm.rejectReasonOther || '').trim()) &&
        (escalationForm.comment || '').trim().length > 0
      )
    : (
        !!ticketId &&
        !isEscalating &&
        !!escalationForm.reason &&
        !(escalationForm.reason === 'Other' && !(escalationForm.reasonOther || '').trim()) &&
        !!escalationForm.severity &&
        !!escalationForm.engageSpeed &&
        // AST Type is required whenever its picker is shown — i.e. when escalating
        // to the Advanced Services group OR when the reason is an Advanced Services request.
        !((escalationForm.assigneeValue === `group:${ESCALATIONS_GROUP_ID}` || escalationForm.reason === 'Advanced Services request') && !escalationForm.astType) &&
        (escalationForm.comment || '').trim().length > 0
      );

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '0',
      marginBottom: '0px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      width: '100%',
      boxSizing: 'border-box',
      overflow: 'hidden',
      wordBreak: 'break-word'
    }}>
      <div
        onClick={() => setEscalationSectionExpanded(!escalationSectionExpanded)}
        style={{
          cursor: 'pointer',
          padding: '10px 12px',
          minHeight: '35px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: escalationSectionExpanded ? '1px solid #D8DCDE' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8,
            backgroundColor: '#EAF2FB', flexShrink: 0
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#2F3941' }}>Escalate Ticket</span>
        </div>
        <span style={{ color: '#68737D', fontSize: 12 }}>
          {escalationSectionExpanded ? '▼' : '▶'}
        </span>
      </div>

      {escalationSectionExpanded && (
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          {!ticketId && (
            <div style={{
              padding: 10, fontSize: 12, color: '#B54708',
              backgroundColor: '#FFF4CC', border: '1px solid #F79A0A', borderRadius: 4
            }}>
              No active ticket detected. Open this app from within a ticket to escalate.
            </div>
          )}

          {/* Mode toggle: Escalate (default) vs Reject (bounce back to original engineer). */}
          <div style={{ display: 'flex', gap: 0, border: '1px solid #D8DCDE', borderRadius: 4, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setEscalationForm({ ...escalationForm, rejectMode: false })}
              style={{
                flex: 1, padding: '6px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                backgroundColor: !escalationForm.rejectMode ? '#1F73B7' : '#FFFFFF',
                color: !escalationForm.rejectMode ? '#FFFFFF' : '#68737D'
              }}
            >
              Escalate
            </button>
            <button
              type="button"
              onClick={() => setEscalationForm({ ...escalationForm, rejectMode: true })}
              style={{
                flex: 1, padding: '6px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                borderLeft: '1px solid #D8DCDE',
                backgroundColor: escalationForm.rejectMode ? '#CC3340' : '#FFFFFF',
                color: escalationForm.rejectMode ? '#FFFFFF' : '#68737D'
              }}
            >
              Reject
            </button>
          </div>

          {escalationForm.rejectMode && (
            <div style={{ padding: 10, fontSize: 12, color: '#68737D', backgroundColor: '#F8F9F9', border: '1px solid #D8DCDE', borderRadius: 4 }}>
              Rejecting returns this ticket to the original assignee and group, sets it back to Open, and adds an internal note explaining why.
            </div>
          )}

          {/* Rejection reason — only in reject mode. */}
          {escalationForm.rejectMode && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Rejection Reason <span style={{ color: '#CC3340' }}>*</span>
              </label>
              <select
                value={escalationForm.rejectReason}
                onChange={(e) => setEscalationForm({ ...escalationForm, rejectReason: e.target.value })}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
              >
                <option value="">— Select rejection reason —</option>
                <option value="Wrong team or engineer">Wrong team or engineer</option>
                <option value="Insufficient information provided">Insufficient information provided</option>
                <option value="Further testing required by requester">Further testing required by requester</option>
                <option value="Not an escalation / handled at current tier">Not an escalation / handled at current tier</option>
                <option value="Duplicate of another escalation">Duplicate of another escalation</option>
                <option value="Other">Other (specify)</option>
              </select>
              {escalationForm.rejectReason === 'Other' && (
                <input
                  type="text"
                  value={escalationForm.rejectReasonOther}
                  onChange={(e) => setEscalationForm({ ...escalationForm, rejectReasonOther: e.target.value })}
                  placeholder="Describe the reason for rejection…"
                  style={{ width: '100%', marginTop: 6, padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
                />
              )}
            </div>
          )}

          {/* Escalation reason — only in escalate mode. */}
          {!escalationForm.rejectMode && (
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Reason for Escalation <span style={{ color: '#CC3340' }}>*</span>
            </label>
            <select
              value={escalationForm.reason}
              onChange={(e) => {
                const newReason = e.target.value;
                const next = { ...escalationForm, reason: newReason };
                // Choosing the Advanced Services reason auto-routes to that group.
                if (newReason === 'Advanced Services request') {
                  next.assigneeValue = `group:${ESCALATIONS_GROUP_ID}`;
                }
                setEscalationForm(next);
              }}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
            >
              <option value="">— Select primary reason —</option>
              <option value="No progress despite multiple attempts">No progress despite multiple attempts</option>
              <option value="Deadline or SLA breach at risk">Deadline or SLA breach at risk</option>
              <option value="Customer threatening to churn">Customer threatening to churn</option>
              <option value="Executive visibility required">Executive visibility required</option>
              <option value="Vendor / TAC engagement needed">Vendor / TAC engagement needed</option>
              <option value="Technical complexity beyond current scope">Technical complexity beyond current scope</option>
              <option value="Subject-matter expertise needed">Subject-matter expertise needed</option>
              <option value="Queue volume / capacity constraints">Queue volume / capacity constraints</option>
              <option value="Advanced Services request">Advanced Services Required</option>
              <option value="Other">Other (specify)</option>
            </select>
            {escalationForm.reason === 'Other' && (
              <input
                type="text"
                value={escalationForm.reasonOther}
                onChange={(e) => setEscalationForm({ ...escalationForm, reasonOther: e.target.value })}
                placeholder="Describe the reason…"
                style={{ width: '100%', marginTop: 6, padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
              />
            )}
          </div>
          )}

          {/* AST Type — shown directly under the reason when Advanced Services is
              the reason, or when the Advanced Services group is the assignee. */}
          {!escalationForm.rejectMode && (escalationForm.reason === 'Advanced Services request' || escalationForm.assigneeValue === `group:${ESCALATIONS_GROUP_ID}`) && (
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                AST Type <span style={{ color: '#CC3340' }}>*</span>
              </label>
              <select
                value={escalationForm.astType}
                onChange={(e) => setEscalationForm({ ...escalationForm, astType: e.target.value })}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
              >
                <option value="">— Select AST Type —</option>
                <option value="escalation_request">Escalation Request</option>
                <option value="certificate_management">Certificate Management</option>
                <option value="license_management">License Management</option>
                <option value="advanced_troubleshooting">Advanced Troubleshooting</option>
                <option value="software_release_management">Software Release Management</option>
                <option value="macd">MACD</option>
                <option value="try_buy">Try &amp; Buy</option>
              </select>
            </div>
          )}

          {/* Escalation-only fields — hidden in reject mode. */}
          {!escalationForm.rejectMode && (
          <>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Current Severity <span style={{ color: '#CC3340' }}>*</span>
            </label>
            <select
              value={escalationForm.severity}
              onChange={(e) => setEscalationForm({ ...escalationForm, severity: e.target.value })}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
            >
              <option value="">— Select —</option>
              <option value="sev1">SEV1 — Critical Outage</option>
              <option value="sev2">SEV2 — Urgent (&gt;25% impact)</option>
              <option value="sev3">SEV3 — Important (&lt;25% impact)</option>
              <option value="sev4">SEV4 — Minor</option>
            </select>
            <div style={{ fontSize: 10, color: '#68737D', marginTop: 2 }}>
              Sets the ticket's Severity field and priority.
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Steps to Reproduce <span style={{ color: '#68737D', fontWeight: 400, textTransform: 'none' }}>(if reproducible)</span>
            </label>
            <textarea
              value={escalationForm.stepsToReproduce}
              onChange={(e) => setEscalationForm({ ...escalationForm, stepsToReproduce: e.target.value })}
              placeholder="1. Log in as user X&#10;2. Navigate to Y&#10;3. Observe Z…"
              rows={3}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Troubleshooting Steps Already Taken
            </label>
            <textarea
              value={escalationForm.troubleshootingTaken}
              onChange={(e) => setEscalationForm({ ...escalationForm, troubleshootingTaken: e.target.value })}
              placeholder="What's already been attempted — TAC cases, vendor involvement, config changes…"
              rows={3}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              How Fast Does Someone Need to Engage <span style={{ color: '#CC3340' }}>*</span>
            </label>
            <select
              value={escalationForm.engageSpeed}
              onChange={(e) => setEscalationForm({ ...escalationForm, engageSpeed: e.target.value })}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
            >
              <option value="">— Select —</option>
              <option value="Immediately (within the hour)">Immediately (within the hour)</option>
              <option value="Same business day">Same business day</option>
              <option value="Within 24 hours">Within 24 hours</option>
              <option value="Within 2-3 business days">Within 2-3 business days</option>
              <option value="No specific deadline">No specific deadline</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Assigned To (Group / Engineer)
            </label>
            <div ref={assigneeBoxRef} style={{ position: 'relative' }}>
              <input
                type="text"
                value={assigneeOpen ? assigneeQuery : assigneeLabel}
                placeholder={assigneeLabel || 'Search group or engineer…'}
                onFocus={() => { setAssigneeOpen(true); setAssigneeQuery(''); }}
                onChange={(e) => { setAssigneeQuery(e.target.value); if (!assigneeOpen) setAssigneeOpen(true); }}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
              />
              {assigneeOpen && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                  marginTop: 2, maxHeight: 240, overflowY: 'auto',
                  border: '1px solid #D8DCDE', borderRadius: 4, backgroundColor: '#FFFFFF',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.12)'
                }}>
                  <div
                    onMouseDown={(e) => { e.preventDefault(); selectAssignee(''); }}
                    style={{ padding: '6px 10px', fontSize: 12, color: '#68737D', cursor: 'pointer', fontStyle: 'italic' }}
                  >
                    — Leave unchanged —
                  </div>

                  {filteredGroups.length > 0 && (
                    <div style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, color: '#68737D', backgroundColor: '#F2F5F7', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Groups
                    </div>
                  )}
                  {filteredGroups.map(g => (
                    <div
                      key={`grp-${g.id}`}
                      onMouseDown={(e) => { e.preventDefault(); selectAssignee(`group:${g.id}`); }}
                      style={{ padding: '6px 10px', fontSize: 12, color: '#1F5FA8', fontWeight: 600, cursor: 'pointer' }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#EAF2FB'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      {g.name} <span style={{ fontWeight: 400, color: '#68737D' }}>(group)</span>
                    </div>
                  ))}

                  {filteredEngineers.length > 0 && (
                    <div style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, color: '#68737D', backgroundColor: '#F2F5F7', textTransform: 'uppercase', letterSpacing: '0.5px', borderTop: '1px solid #E4E8EA' }}>
                      Engineers
                    </div>
                  )}
                  {filteredEngineers.map(m => (
                    <div
                      key={`eng-${m.id}`}
                      onMouseDown={(e) => { e.preventDefault(); selectAssignee(`agent:${m.id}`); }}
                      style={{ padding: '6px 10px', fontSize: 12, color: '#2F3941', cursor: 'pointer' }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#EAF2FB'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      {m.name}
                    </div>
                  ))}

                  {filteredGroups.length === 0 && filteredEngineers.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: '#68737D' }}>No matches.</div>
                  )}
                </div>
              )}
            </div>
            {(!assigneeOptions || assigneeOptions.length === 0) && (
              <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>Loading assignees…</div>
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Status
            </label>
            <select
              value={escalationForm.status}
              onChange={(e) => setEscalationForm({ ...escalationForm, status: e.target.value })}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
            >
              <option value="">— Leave unchanged —</option>
              {(statusOptions || []).map(s => (
                <option key={s.id} value={String(s.id)}>{s.label}</option>
              ))}
            </select>
            {(!statusOptions || statusOptions.length === 0) && (
              <div style={{ fontSize: 11, color: '#68737D', marginTop: 4 }}>Loading statuses…</div>
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Escalation Bridge
            </label>
            <input
              type="text"
              value={escalationForm.bridge}
              onChange={(e) => setEscalationForm({ ...escalationForm, bridge: e.target.value })}
              placeholder="Bridge link or dial-in (if one was created)"
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box' }}
            />
          </div>
          </>
          )}

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#68737D', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Additional Notes <span style={{ color: '#CC3340' }}>*</span>
            </label>
            <textarea
              value={escalationForm.comment}
              onChange={(e) => setEscalationForm({ ...escalationForm, comment: e.target.value })}
              placeholder="Anything else the escalation team should know…"
              rows={3}
              style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid #D8DCDE', borderRadius: 4, color: '#2F3941', backgroundColor: '#FFFFFF', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <button
            onClick={handleEscalate}
            disabled={!canSubmit}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 600,
              backgroundColor: !canSubmit ? '#A9C5E4' : (escalationForm.rejectMode ? '#CC3340' : '#1F5FA8'),
              color: '#FFFFFF', border: 'none', borderRadius: 4,
              cursor: canSubmit ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap'
            }}
          >
            {isEscalating
              ? (escalationForm.rejectMode ? 'Rejecting…' : 'Escalating…')
              : (escalationForm.rejectMode ? 'Reject Ticket' : 'Escalate Ticket')}
          </button>
        </div>
      )}
    </div>
  );
}

function App() {
  console.log('[Asset Manager] App component starting...');
  console.log('[Asset Manager] ZAFClient available:', !!window.ZAFClient);
  console.log('[Asset Manager] Backend URL:', BACKEND_BASE_URL);

  const [assets, setAssets] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [requester, setRequester] = useState(null);
  const [requesterOrg, setRequesterOrg] = useState(null);
  const [requesterSectionExpanded, setRequesterSectionExpanded] = useState(false);
  const [subscriptionsSectionExpanded, setSubscriptionsSectionExpanded] = useState(false);
  const [assetsSectionExpanded, setAssetsSectionExpanded] = useState(false);
  const [calendarSectionExpanded, setCalendarSectionExpanded] = useState(false); // Added for calendar
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [formData, setFormData] = useState({});
  const [users, setUsers] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [newAssetForm, setNewAssetForm] = useState({});
  const [createAssetExpanded, setCreateAssetExpanded] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [customerNotes, setCustomerNotes] = useState([]);
  const [customerNotesSectionExpanded, setCustomerNotesSectionExpanded] = useState(false);
  const [showAddNote, setShowAddNote] = useState(false);
  const [editingNote, setEditingNote] = useState(null);
  const [noteForm, setNoteForm] = useState({ text: '', priority: 'normal' });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [assetToCreate, setAssetToCreate] = useState(null);
  const [knownIssuesSectionExpanded, setKnownIssuesSectionExpanded] = useState(false);
  const [knownIssues, setKnownIssues] = useState([]);

  // Auto CC rules (persisted to org field `auto_cc_rules`)
  const [autoCcSectionExpanded, setAutoCcSectionExpanded] = useState(false);
  const [autoCcRules, setAutoCcRules] = useState([]);
  const [showAddCcRule, setShowAddCcRule] = useState(false);
  const [editingCcRule, setEditingCcRule] = useState(null);
  const [ccRuleForm, setCcRuleForm] = useState({
    email: '',
    scope: 'all_alarms',
    locationKeywords: []
  });

  // Suppressed alarms (persisted to org field `auto_cc_blocked`)
  const [suppressSectionExpanded, setSuppressSectionExpanded] = useState(false);
  const [suppressions, setSuppressions] = useState([]);
  const [showAddSuppress, setShowAddSuppress] = useState(false);
  const [editingSuppress, setEditingSuppress] = useState(null);
  const [suppressForm, setSuppressForm] = useState({
    device: '',
    alarmType: '',
    note: '',
    expiresOn: ''
  });

  // Escalation contacts (persisted to org field `escalation_contacts`)
  const [contactsSectionExpanded, setContactsSectionExpanded] = useState(false);
  const [escalationContacts, setEscalationContacts] = useState([]);
  const [showAddContact, setShowAddContact] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [escalationProcedure, setEscalationProcedure] = useState('');
  // Alarm fields parsed from the current ticket, for the "Mute this alarm" prefill.
  const [parsedAlarm, setParsedAlarm] = useState({
    isAlarm: false, company: '', fqdn: '', alarmType: '', site: ''
  });
  const [contactForm, setContactForm] = useState({
    name: '',
    site: '',
    role: '',
    phone: '',
    email: '',
    note: ''
  });
  const [showAddIssue, setShowAddIssue] = useState(false);
  const [editingIssue, setEditingIssue] = useState(null);
  const [issueForm, setIssueForm] = useState({
    title: '',
    description: '',
    severity: 'low',
    status: 'active'
  });
  const [issueToDelete, setIssueToDelete] = useState(null);
  const [showDeleteIssueConfirm, setShowDeleteIssueConfirm] = useState(false);

  // Ticket escalation state (replaces the Zendesk escalation macro)
  const [escalationSectionExpanded, setEscalationSectionExpanded] = useState(false);
  const [ticketId, setTicketId] = useState(null);
  const [assigneeOptions, setAssigneeOptions] = useState([]);
  const [statusOptions, setStatusOptions] = useState([]);
  const [isEscalating, setIsEscalating] = useState(false);
  const [escalationForm, setEscalationForm] = useState({
    reason: '',
    reasonOther: '',
    severity: '',
    stepsToReproduce: '',
    troubleshootingTaken: '',
    engageSpeed: '',
    status: '',
    assigneeValue: '',
    comment: '',
    astType: '',
    bridge: '',
    rejectMode: false,
    rejectReason: '',
    rejectReasonOther: ''
  });

  const [selectedCalendar, setSelectedCalendar] = useState('ops'); // 'ops' or 'pto'
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarConfig, setCalendarConfig] = useState({
    opsCalendarId: 'primary',
    ptoCalendarId: null
  });

  // IT Portal Assets state
  const [itPortalAssets, setItPortalAssets] = useState([]);
  const [itPortalLoading, setItPortalLoading] = useState(false);
  const [itPortalError, setItPortalError] = useState(null);
  const [itPortalSectionExpanded, setItPortalSectionExpanded] = useState(false);
  const [itPortalLastUpdated, setItPortalLastUpdated] = useState(null);
  const [selectedItPortalAsset, setSelectedItPortalAsset] = useState(null);
  const [itPortalFormData, setItPortalFormData] = useState({});
  const [editingItPortalAsset, setEditingItPortalAsset] = useState(false);
  const [companiesWithAssets, setCompaniesWithAssets] = useState([]);
  const [isMultiCompany, setIsMultiCompany] = useState(false);
  const [isBILH, setIsBILH] = useState(false);
  const [expandedHospitals, setExpandedHospitals] = useState({});
  const [itPortalSearchQuery, setItPortalSearchQuery] = useState('');
  // Lowercased ticket subject+description, used to highlight matching IT Portal assets.
  const [ticketText, setTicketText] = useState('');

  // Pull the asset's connectable FQDN. Assets carry it in `name` (e.g.
  // "avaadscl-mpav.massport.com"); fall back to other FQDN-ish fields.
  const getAssetFqdn = (asset) => {
    const candidates = [asset.fqdn, asset.name, asset.host_name, asset.hostname];
    for (const c of candidates) {
      const v = (c || '').trim();
      // Looks like an FQDN: has a dot and only host-safe characters.
      if (v && /^[a-z0-9.-]+\.[a-z0-9.-]+$/i.test(v)) return v;
    }
    return '';
  };

  // Exact-FQDN match: the asset's full FQDN must appear in the ticket text as a
  // whole token (bounded by non-FQDN chars), so a shared domain suffix like
  // "mpav.massport.com" never matches on its own — only the complete FQDN does.
  const assetMatchesTicket = (asset) => {
    if (!ticketText) return false;
    const fqdn = getAssetFqdn(asset).toLowerCase();
    if (!fqdn) return false;
    const esc = fqdn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Boundaries: start/end of string or any char that can't be part of an FQDN.
    const re = new RegExp(`(^|[^a-z0-9.-])${esc}([^a-z0-9.-]|$)`, 'i');
    return re.test(ticketText);
  };

  // Initiate an SSH/Twingate connection to the asset via the local URL-scheme
  // handler installed on the agent's Mac. The handler runs:
  //   ssh -t tools "/tools/linux/fconnect <fqdn>"
  const connectToAsset = (asset) => {
    const fqdn = getAssetFqdn(asset);
    if (!fqdn) {
      alert('No FQDN available for this asset, so a direct connection cannot be started. Open Terminal and use the menu manually.');
      return;
    }
    const url = ticketId
      ? `intlxtools://connect?fqdn=${encodeURIComponent(fqdn)}&case=${encodeURIComponent(ticketId)}`
      : `intlxtools://connect?fqdn=${encodeURIComponent(fqdn)}`;
    console.log('[Asset Manager] Initiating connection:', url);
    // Fire the custom scheme. window.location is the most reliable trigger for
    // protocol handlers inside the ZAF iframe.
    try {
      window.location.href = url;
    } catch (e) {
      try { window.open(url, '_self'); } catch (_) { /* ignore */ }
    }
  };

  // Open the asset's web interface over HTTPS in a new tab.
  const openAssetHttp = (asset) => {
    const fqdn = getAssetFqdn(asset);
    if (!fqdn) {
      alert('No FQDN available for this asset, so a web connection cannot be opened.');
      return;
    }
    const url = `https://${fqdn}`;
    console.log('[Asset Manager] Opening HTTP:', url);
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const [filteredItPortalAssets, setFilteredItPortalAssets] = useState([]);

  // IT Portal Assets functions
  async function fetchITPortalAssets() {
  if (!requester?.id) return;
  
  setItPortalLoading(true);
  setItPortalError(null);
  
  try {
    console.log('[Asset Manager] Fetching IT Portal assets for user:', requester.id);
    const response = await fetch(`${BACKEND_BASE_URL}/api/it-portal-assets?user_id=${requester.id}`, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch IT Portal assets: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[Asset Manager] IT Portal assets received:', data);
    
    // Handle the enhanced multi-company response structure
    setItPortalAssets(data.assets || []);
    setCompaniesWithAssets(data.companies || []);  // NEW
    setIsMultiCompany(data.is_multi_company || false);  // NEW
    setIsBILH(data.is_bilh || false);  // NEW
    setItPortalLastUpdated(new Date());
    
    // Enhanced logging for BILH
    if (data.is_bilh) {
      console.log('[Asset Manager] Beth Israel Lahey Health network detected');
      console.log(`[Asset Manager] BILH Hospitals found:`, data.companies?.map(c => c.name));
      console.log(`[Asset Manager] Total BILH devices: ${data.assets?.length || 0} across ${data.companies?.length || 0} hospitals`);
    }
    
  } catch (err) {
    console.error('[Asset Manager] Error fetching IT Portal assets:', err);
    setItPortalError(err.message);
  } finally {
    setItPortalLoading(false);
  }
}

// ========= ADD THE NEW CALENDAR FUNCTION HERE =========
 async function fetchCalendarEvents() {
  setCalendarLoading(true);
  try {
    let currentConfig = calendarConfig;
    
    // If config isn't ready, fetch it and get the fresh data
    if (!currentConfig.opsCalendarId || currentConfig.opsCalendarId === 'primary' || 
        (selectedCalendar === 'pto' && !currentConfig.ptoCalendarId)) {
      console.log('[Asset Manager] Calendar config not ready, fetching...');
      const freshConfig = await fetchCalendarConfig();
      if (freshConfig) {
        currentConfig = freshConfig; // Use fresh config immediately
      }
    }
    
    const calendarId = selectedCalendar === 'pto' 
      ? currentConfig.ptoCalendarId 
      : currentConfig.opsCalendarId;
    
    if (!calendarId || calendarId === 'primary') {
      console.error('[Asset Manager] No proper calendar ID configured for:', selectedCalendar, 'got:', calendarId);
      setCalendarEvents([]);
      setCalendarLoading(false);
      return;
    }
    
    console.log('[Asset Manager] Fetching calendar events for:', selectedCalendar, 'with ID:', calendarId);
    
    const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/events?calendarId=${encodeURIComponent(calendarId)}`, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch calendar: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[Asset Manager] Calendar events received:', data.events?.length, 'events');
    setCalendarEvents(data.events || []);
    
  } catch (err) {
    console.error('[Asset Manager] Error fetching calendar:', err);
    setCalendarEvents([]);
  } finally {
    setCalendarLoading(false);
  }
}

  async function fetchCalendarConfig() {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/ops-calendar/config`);
    if (response.ok) {
      const config = await response.json();
      
      setCalendarConfig({
        opsCalendarId: config.calendarId || 'primary',
        ptoCalendarId: config.ptoCalendarId  // This comes from your backend ENV variable
      });
      
      console.log('[Asset Manager] Calendar config loaded:', {
        ops: config.calendarId,
        pto: config.ptoCalendarId
      });
    }
  } catch (err) {
    console.error('[Asset Manager] Error fetching calendar config:', err);
  }
}
  // ========= END OF NEW CALENDAR FUNCTION =========

  function getDeviceIcon(deviceType) {
    const type = deviceType?.toLowerCase() || '';
    
    if (type.includes('gateway') || type.includes('router') || type.includes('switch')) {
      return '🌐';
    }
    if (type.includes('phone') || type.includes('mobile')) {
      return '📱';
    }
    if (type.includes('storage') || type.includes('disk')) {
      return '💾';
    }
    return '🖥️';
  }

  useEffect(() => {
    console.log('[Asset Manager] useEffect running...');
    
    if (!window.ZAFClient) {
      console.error('[Asset Manager] ZAFClient not available - waiting...');
      setLoading(false);
      return;
    }

    const client = window.ZAFClient.init();
    console.log('[Asset Manager] ZAF client initialized:', client);
    
    setProxy(BACKEND_BASE_URL);
    client.invoke("resize");

    async function load() {
      try {
        console.log('[Asset Manager] Getting ticket data...');
        fetchCalendarConfig(); // Fetch calendar configuration
        const ticketData = await client.get("ticket.requester");
        console.log('[Asset Manager] Ticket data received:', ticketData);
        
        const requesterData = ticketData["ticket.requester"];
        console.log('[Asset Manager] Requester data structure:', requesterData);
        
        setRequester(requesterData);

        // Capture the current ticket ID + load assignees for escalation
        loadEscalationContext(client);

        if (requesterData?.id) {
          console.log('[Asset Manager] Fetching full user details for ID:', requesterData.id);
          try {
            const fullUserData = await getUser(requesterData.id);
            console.log('[Asset Manager] Full user data from API:', fullUserData);
            
            const mergedUserData = { ...requesterData, ...fullUserData };
            setRequester(mergedUserData);

            const orgId = fullUserData?.organization_id || requesterData?.organization_id;
            if (orgId) {
              console.log('[Asset Manager] Fetching organization for ID:', orgId);
              try {
                const orgData = await getOrganization(orgId);
                console.log('[Asset Manager] Organization data:', orgData);
                setRequesterOrg(orgData);
                
                // Update the merged user data with the confirmed organization ID
                const updatedMergedUserData = { ...mergedUserData, organization_id: orgId };
                setRequester(updatedMergedUserData);
                
                // Initialize customer notes from organization custom field (structured data)
                const customerNotesData = orgData?.organization_fields?.customer_notes_data || '';

                if (customerNotesData) {
                  try {
                    console.log('[Asset Manager] Raw customer notes data:', customerNotesData);
                    const parsedNotes = typeof customerNotesData === 'string' ? 
                      JSON.parse(customerNotesData) : customerNotesData;
                    setCustomerNotes(Array.isArray(parsedNotes) ? parsedNotes : []);
                    console.log('[Asset Manager] Customer notes loaded:', parsedNotes);
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing customer notes:', parseErr);
                    // Try to migrate old plain-text notes
                    if (typeof customerNotesData === 'string' && customerNotesData.trim()) {
                      const migratedNotes = customerNotesData.split('\n')
                        .filter(line => line.trim())
                        .map((line, index) => ({
                          id: `migrated-${Date.now()}-${index}`,
                          text: line.trim(),
                          priority: 'normal',
                          created_at: new Date().toISOString(),
                          created_by: 'Migrated'
                        }));
                      setCustomerNotes(migratedNotes);
                      console.log('[Asset Manager] Migrated old notes to new format:', migratedNotes);
                    } else {
                      setCustomerNotes([]);
                    }
                  }
                } else {
                  console.log('[Asset Manager] No customer notes found for organization');
                  setCustomerNotes([]);
                }

                // Load known issues from organization - ADD THIS SECTION HERE
                const knownIssuesData = orgData?.organization_fields?.known_issues || '';
                if (knownIssuesData) {
                  try {
                    console.log('[Asset Manager] Raw known issues data:', knownIssuesData);
                    const parsedIssues = typeof knownIssuesData === 'string' ? 
                      JSON.parse(knownIssuesData) : knownIssuesData;
                    setKnownIssues(Array.isArray(parsedIssues) ? parsedIssues : []);
                    console.log('[Asset Manager] Known issues loaded:', parsedIssues);
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing known issues:', parseErr);
                    setKnownIssues([]);
                  }
                } else {
                  console.log('[Asset Manager] No known issues found for organization');
                  setKnownIssues([]);
                }

                // Load auto CC rules from organization
                const autoCcRulesData = orgData?.organization_fields?.auto_cc_rules || '';
                if (autoCcRulesData) {
                  try {
                    const parsedRules = typeof autoCcRulesData === 'string'
                      ? JSON.parse(autoCcRulesData)
                      : autoCcRulesData;
                    setAutoCcRules(Array.isArray(parsedRules) ? parsedRules : []);
                    console.log('[Asset Manager] Auto CC rules loaded:', parsedRules);
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing auto CC rules:', parseErr);
                    setAutoCcRules([]);
                  }
                } else {
                  // Legacy fallback: hydrate from the old flat `auto_cc` string so the
                  // card isn't blank for un-migrated orgs. Display only — nothing is
                  // written back until an agent saves. Scope is `all_tickets` because
                  // that is what the old field actually did (no alarm/sev filtering).
                  const legacyAutoCc = orgData?.organization_fields?.auto_cc || '';
                  if (legacyAutoCc) {
                    const legacyRules = String(legacyAutoCc)
                      .replace(/;/g, ',')
                      .split(',')
                      .map(e => e.trim())
                      .filter(Boolean)
                      .map(email => ({
                        id: `legacy_${email}`,
                        email,
                        scope: 'all_tickets',
                        locationKeywords: [],
                        legacy: true
                      }));
                    setAutoCcRules(legacyRules);
                    console.log('[Asset Manager] Auto CC hydrated from legacy field:', legacyRules);
                  } else {
                    console.log('[Asset Manager] No auto CC rules found for organization');
                    setAutoCcRules([]);
                  }
                }

                // Load suppressed alarms from organization
                const suppressData = orgData?.organization_fields?.auto_cc_blocked || '';
                if (suppressData) {
                  try {
                    const parsedSuppress = typeof suppressData === 'string'
                      ? JSON.parse(suppressData)
                      : suppressData;
                    setSuppressions(Array.isArray(parsedSuppress) ? parsedSuppress : []);
                    console.log('[Asset Manager] Suppressed alarms loaded:', parsedSuppress);
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing suppressed alarms:', parseErr);
                    setSuppressions([]);
                  }
                } else {
                  console.log('[Asset Manager] No suppressed alarms found for organization');
                  setSuppressions([]);
                }

                // Load escalation contacts from organization
                const contactsData = orgData?.organization_fields?.escalation_contacts || '';
                if (contactsData) {
                  try {
                    const parsedContacts = typeof contactsData === 'string'
                      ? JSON.parse(contactsData)
                      : contactsData;
                    setEscalationContacts(Array.isArray(parsedContacts) ? parsedContacts : []);
                    console.log('[Asset Manager] Escalation contacts loaded:', parsedContacts);
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing escalation contacts:', parseErr);
                    setEscalationContacts([]);
                  }
                } else {
                  console.log('[Asset Manager] No escalation contacts found for organization');
                  setEscalationContacts([]);
                }

                // Load escalation procedure (plain text, not JSON)
                const procedureData = orgData?.organization_fields?.escalation_procedure || '';
                setEscalationProcedure(typeof procedureData === 'string' ? procedureData : '');
                console.log('[Asset Manager] Escalation procedure loaded:', procedureData ? '(present)' : '(none)');

                // Get subscriptions from organization custom field
                console.log('[Asset Manager] Checking organization custom fields for subscriptions');
                const activeSubscriptions = orgData?.organization_fields?.active_subscriptions || '';
                
                if (activeSubscriptions) {
                  try {
                    console.log('[Asset Manager] Raw subscriptions data:', activeSubscriptions);
                    
                    // Parse subscriptions - could be JSON string or already parsed
                    let subscriptionsData;
                    if (typeof activeSubscriptions === 'string') {
                      subscriptionsData = JSON.parse(activeSubscriptions);
                    } else {
                      subscriptionsData = activeSubscriptions;
                    }
                    
                    console.log('[Asset Manager] Parsed subscriptions:', subscriptionsData);
                    const subs = Array.isArray(subscriptionsData) ? subscriptionsData : [];
                    setSubscriptions(subs);
                    
                  } catch (parseErr) {
                    console.error('[Asset Manager] Error parsing subscriptions from custom field:', parseErr);
                    console.log('[Asset Manager] Treating as plain text subscription list');
                    
                    // If it's not JSON, treat as plain text list
                    const textSubs = activeSubscriptions.split('\n')
                      .filter(line => line.trim())
                      .map((line, index) => ({
                        id: `text-${index}`,
                        name: line.trim(),
                        status: 'active'
                      }));
                    
                    setSubscriptions(textSubs);
                  }
                } else {
                  console.log('[Asset Manager] No active subscriptions custom field found');
                  setSubscriptions([]);
                }

                // Now fetch assets using the organization NAME instead of ID for cross-system compatibility
                console.log('[Asset Manager] *** DEBUG: Current requester organization ID:', orgId);
                console.log('[Asset Manager] *** DEBUG: Current requester organization NAME:', orgData?.name);
                console.log('[Asset Manager] *** DEBUG: Organization ID type:', typeof orgId);

                try {
                  // First try to get ALL assets and filter client-side by organization name
                  console.log('[Asset Manager] *** DEBUG: Fetching ALL assets to debug filtering by organization name...');
                  const allAssetsResponse = await fetch(`${BACKEND_BASE_URL}/api/assets`);
                  
                  if (allAssetsResponse.ok) {
                    const allAssetsData = await allAssetsResponse.json();
                    const allAssets = allAssetsData.assets || allAssetsData.custom_object_records || allAssetsData || [];
                    console.log('[Asset Manager] *** DEBUG: ALL assets received:', allAssets);
                    
                    // Show complete asset structure for debugging
                    if (Array.isArray(allAssets) && allAssets.length > 0) {
                      console.log('[Asset Manager] *** DEBUG: First asset complete structure:', JSON.stringify(allAssets[0], null, 2));
                      
                      const targetOrgName = orgData?.name?.toLowerCase().trim();
                      const targetOrgId = orgId.toString();
                      const currentUserId = requesterData.id.toString();
                      
                      console.log('[Asset Manager] *** DEBUG: Target filters:');
                      console.log(`  - Target org name: "${targetOrgName}"`);
                      console.log(`  - Target org ID: "${targetOrgId}"`);
                      console.log(`  - Current user ID: "${currentUserId}"`);
                      
                      // ULTRA-RESTRICTIVE filtering - ONLY show assets assigned to this exact user
                      const validAssets = [];
                      
                      allAssets.forEach((asset, index) => {
                        console.log(`[Asset Manager] *** USER-ONLY FILTER: Asset ${index} (${asset.name}):`);
                        
                        let shouldInclude = false;
                        let reason = 'NO DIRECT USER ASSIGNMENT';
                        
                        const fields = asset.custom_object_fields || {};
                        
                        // ONLY CHECK: Direct user assignment - no org matching
                        const assignedUserId = fields.assigned_to;
                        if (assignedUserId && assignedUserId.toString() === currentUserId) {
                          shouldInclude = true;
                          reason = `DIRECT USER ASSIGNMENT (${assignedUserId} === ${currentUserId})`;
                        }
                        
                        console.log(`  - Asset assigned_to: ${assignedUserId}`);
                        console.log(`  - Current user ID: ${currentUserId}`);
                        console.log(`  - Decision: ${shouldInclude ? 'INCLUDE' : 'EXCLUDE'}`);
                        console.log(`  - Reason: ${reason}`);
                        console.log('  ---');
                        
                        if (shouldInclude) {
                          validAssets.push(asset);
                        }
                      });
                      
                      console.log('[Asset Manager] *** FINAL RESULT (USER-ONLY):');
                      console.log(`  - Total assets checked: ${allAssets.length}`);
                      console.log(`  - Assets assigned to current user: ${validAssets.length}`);
                      console.log('  - Included assets:', validAssets.map(a => `${a.name} (${a.custom_object_fields?.asset_name})`));
                      
                      setAssets(validAssets);
                      
                    } else {
                      console.log('[Asset Manager] *** DEBUG: Assets data is not an array:', allAssets);
                      setAssets([]);
                    }
                  } else {
                    console.log('[Asset Manager] *** DEBUG: Failed to fetch all assets, status:', allAssetsResponse.status);
                    // Fallback to user assets if API fails
                    const userId = requesterData?.id;
                    if (userId) {
                      const userAssets = await getAssetsByUserId(userId);
                      console.log('[Asset Manager] Fallback user assets received:', userAssets);
                      setAssets(userAssets || []);
                    } else {
                      setAssets([]);
                    }
                  }
                } catch (assetErr) {
                  console.error('[Asset Manager] Error fetching organization assets:', apiErrorToText(assetErr));
                  // Fallback to user assets on error
                  const userId = requesterData?.id;
                  if (userId) {
                    try {
                      console.log('[Asset Manager] Falling back to user assets for:', userId);
                      const userAssets = await getAssetsByUserId(userId);
                      console.log('[Asset Manager] Fallback user assets received:', userAssets);
                      setAssets(userAssets || []);
                    } catch (fallbackErr) {
                      console.error('[Asset Manager] Error fetching fallback user assets:', apiErrorToText(fallbackErr));
                      setAssets([]);
                    }
                  } else {
                    setAssets([]);
                  }
                }

              } catch (err) {
                console.error('[Asset Manager] Error fetching organization:', apiErrorToText(err));
                setRequesterOrg(null);
                // If organization fetch fails, fall back to user assets
                const userId = requesterData?.id;
                if (userId) {
                  try {
                    const userAssets = await getAssetsByUserId(userId);
                    console.log('[Asset Manager] User assets received after org error:', userAssets);
                    setAssets(userAssets || []);
                  } catch (userErr) {
                    console.error('[Asset Manager] Error fetching user assets after org error:', apiErrorToText(userErr));
                    setAssets([]);
                  }
                }
              }
            } else {
              console.log('[Asset Manager] No organization ID found, skipping organization and asset fetch');
              // If no org ID, try user assets
              const userId = requesterData?.id;
              if (userId) {
                try {
                  const userAssets = await getAssetsByUserId(userId);
                  console.log('[Asset Manager] User assets received (no org):', userAssets);
                  setAssets(userAssets || []);
                } catch (userErr) {
                  console.error('[Asset Manager] Error fetching user assets (no org):', apiErrorToText(userErr));
                  setAssets([]);
                }
              }
            }
          } catch (err) {
            console.error('[Asset Manager] Error fetching full user details:', apiErrorToText(err));
          }
        }

        const userId = ticketData["ticket.requester"]?.id;
        console.log('[Asset Manager] User ID:', userId);

        try {
          const response = await fetch(`${BACKEND_BASE_URL}/api/users`);
          const userData = await response.json();
          console.log('[Asset Manager] Users data:', userData);
          setUsers(userData.users || []);
        } catch (err) {
          console.error('[Asset Manager] Error fetching users:', apiErrorToText(err));
          setUsers([]);
        }

        try {
          console.log('[Asset Manager] Fetching organizations...');
          const response = await fetch(`${BACKEND_BASE_URL}/api/organizations`);
          
          if (!response.ok) {
            throw new Error(`Organizations API returned ${response.status}`);
          }
          
          const orgData = await response.json();
          console.log('[Asset Manager] Organizations response:', orgData);
          
          const orgs = orgData.organizations || [];
          setOrganizations(orgs);
          
        } catch (err) {
          console.error('[Asset Manager] Error fetching organizations:', err);
          setOrganizations([]);
        }

      } catch (err) {
        console.error('[Asset Manager] Error in load function:', err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  // IT Portal Assets useEffect
  useEffect(() => {
    if (requester?.id && requesterOrg?.id) {
      fetchITPortalAssets();
    }
  }, [requester?.id, requesterOrg?.id]);

  // Filter IT Portal assets based on search query
useEffect(() => {
  if (!itPortalSearchQuery.trim()) {
    setFilteredItPortalAssets(itPortalAssets);
    return;
  }
  
  const query = itPortalSearchQuery.toLowerCase();
  const filtered = itPortalAssets.filter(asset => {
    // Search across multiple fields
    const searchableText = [
      asset.asset_tag,
      asset.name,
      asset.host_name,
      asset.hostname,
      asset.device_type,
      asset.type,
      asset.description,
      asset.domain,
      asset.realm,
      asset.facility,
      asset.location,
      asset.username,
      asset.assigned_user,
      asset.company_name,
      asset.hospital_name,
      asset.serial_number,
      asset.manufacturer,
      asset.model,
      asset.status
    ].filter(Boolean).join(' ').toLowerCase();
    
    return searchableText.includes(query);
  });
  
  setFilteredItPortalAssets(filtered);
}, [itPortalSearchQuery, itPortalAssets]);

  // Fetch calendar events when component mounts or calendar selection changes
  useEffect(() => {
    fetchCalendarEvents();
  }, [selectedCalendar]);

  function handleAssetClick(asset) {
    console.log('[Asset Manager] Asset clicked:', asset);
    setSelectedAsset(asset);
    
    const assetOrgId = asset.custom_object_fields?.organization || 
                     asset.custom_object_fields?.assigned_to_org ||
                     requester?.organization_id;
    
    setFormData({
      ...asset.custom_object_fields,
      assigned_to_user: asset.custom_object_fields?.assigned_to || '',
      assigned_to_org: assetOrgId || ''
    });
  }

  function handleInputChange(e, setTargetState) {
    const { name, value } = e.target;
    console.log('[Asset Manager] Input changed:', name, value);
    setTargetState((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSave() {
    if (!selectedAsset) return;
    
    console.log('[Asset Manager] Saving asset:', selectedAsset.id, formData);
    
    try {
      let payload = { ...formData };

      if (formData.assigned_to_user) {
        payload.assigned_to = formData.assigned_to_user;
        delete payload.assigned_to_org;
      } else if (formData.assigned_to_org) {
        payload.organization = formData.assigned_to_org;
        delete payload.assigned_to_user;
      } else {
        delete payload.assigned_to_user;
        delete payload.assigned_to_org;
      }

      delete payload.assigned_to_user;
      delete payload.assigned_to_org;

      const response = await updateAsset(selectedAsset.id, payload);
      const updatedAsset = await getAssetById(selectedAsset.id);

      setAssets((prevAssets) =>
        prevAssets.map((a) => (a.id === selectedAsset.id ? updatedAsset : a))
      );
      
      alert("Asset updated successfully!");
      setSelectedAsset(null);
    } catch (err) {
      console.error('[Asset Manager] Save error:', err);
      alert("Error updating asset: " + apiErrorToText(err));
    }
  }

  async function handleCreateNewAsset() {
    console.log('[Asset Manager] Preparing to create new asset:', newAssetForm);
    
    setFormErrors({});
    
    const requiredFields = ["asset_name", "manufacturer", "model_number"];
    const errors = {};
    
    requiredFields.forEach(field => {
      if (!newAssetForm[field]?.trim()) {
        errors[field] = "This field is required";
      }
    });

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    // Prepare the asset data and show confirmation instead of creating immediately
    const assetPayload = {
      name: `${newAssetForm.asset_name}_${Date.now()}`,
      custom_object_fields: {
        asset_name: newAssetForm.asset_name.trim(),
        manufacturer: newAssetForm.manufacturer.trim(),
        model_number: newAssetForm.model_number.trim(),
        serial_number: newAssetForm.serial_number?.trim() || '',
        status: newAssetForm.status || 'active',
        assigned_to: newAssetForm.assigned_to_user || requester?.id?.toString() || '',
        organization: newAssetForm.assigned_to_org || requester?.organization_id?.toString() || '',
        purchase_date: newAssetForm.purchase_date || null,
        warranty_expiration: newAssetForm.warranty_expiration || null,
        approved_by: newAssetForm.approved_by?.trim() || null
      }
    };

    setAssetToCreate(assetPayload);
    setShowCreateConfirm(true);
  }

  async function confirmCreateAsset() {
    if (!assetToCreate) return;
    
    setShowCreateConfirm(false);
    
    console.log('[Asset Manager] Creating asset:', assetToCreate);
    
    try {
      const response = await fetch(`${BACKEND_BASE_URL}/api/assets`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(assetToCreate),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`API Error ${response.status}: ${errorData}`);
      }

      const responseData = await response.json();
      let createdAsset = responseData.custom_object_record || responseData.asset || responseData.data || responseData;

      const formattedAsset = {
        id: createdAsset.id || `temp-${Date.now()}`,
        name: createdAsset.name || "New Asset",
        custom_object_fields: {
          asset_name: createdAsset.custom_object_fields?.asset_name || assetToCreate.custom_object_fields.asset_name,
          manufacturer: createdAsset.custom_object_fields?.manufacturer || assetToCreate.custom_object_fields.manufacturer,
          model_number: createdAsset.custom_object_fields?.model_number || assetToCreate.custom_object_fields.model_number,
          serial_number: createdAsset.custom_object_fields?.serial_number || assetToCreate.custom_object_fields.serial_number,
          status: createdAsset.custom_object_fields?.status || assetToCreate.custom_object_fields.status,
          assigned_to: createdAsset.custom_object_fields?.assigned_to || assetToCreate.custom_object_fields.assigned_to,
          organization: createdAsset.custom_object_fields?.organization || assetToCreate.custom_object_fields.organization,
          purchase_date: createdAsset.custom_object_fields?.purchase_date || assetToCreate.custom_object_fields.purchase_date,
          warranty_expiration: createdAsset.custom_object_fields?.warranty_expiration || assetToCreate.custom_object_fields.warranty_expiration,
          approved_by: createdAsset.custom_object_fields?.approved_by || assetToCreate.custom_object_fields.approved_by
        }
      };

      setAssets((prevAssets) => [...prevAssets, formattedAsset]);
      setNewAssetForm({});
      setFormErrors({});
      setAssetToCreate(null);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', `Asset created successfully!\nName: ${formattedAsset.custom_object_fields.asset_name}`, 'notice');
      } else {
        alert(`Asset created successfully!\nID: ${createdAsset.id}\nName: ${createdAsset.name}`);
      }
      
    } catch (err) {
      console.error('[Asset Manager] Asset creation error:', err);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'Error: Failed to create asset - ' + (err.message || 'Unknown error'), 'error');
      } else {
        alert("Failed to create asset: " + (err.message || 'Unknown error'));
      }
    }
  }

  function cancelCreateAsset() {
    setShowCreateConfirm(false);
    setAssetToCreate(null);
  }

  async function handleDeleteAsset() {
    if (!selectedAsset) return;
    
    // Show confirmation modal instead of proceeding immediately
    setShowDeleteConfirm(true);
  }

  async function confirmDelete() {
    if (!selectedAsset) return;
    
    setShowDeleteConfirm(false);
    
    if (!window.ZAFClient) {
      console.error('[Asset Manager] ZAFClient not available for delete');
      return;
    }

    console.log('[Asset Manager] Deleting asset:', selectedAsset.id);
    
    try {
      const client = window.ZAFClient.init();
      
      const response = await fetch(`${BACKEND_BASE_URL}/api/assets/${selectedAsset.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        
        // Check if it's a 404 "Cannot DELETE" error - backend doesn't support delete
        if (response.status === 404 && errorText.includes('Cannot DELETE')) {
          throw new Error('Delete functionality is not yet implemented on the backend server. Please contact your system administrator.');
        }
        
        throw new Error(`Delete failed (${response.status}): ${errorText}`);
      }

      console.log('[Asset Manager] Asset deleted successfully');
      
      // Remove the asset from local state
      setAssets(prevAssets => prevAssets.filter(a => a.id !== selectedAsset.id));
      
      // Close the modal and show success notification
      setSelectedAsset(null);
      
      await client.invoke('notify', 'Asset deleted successfully!', 'notice');
      
    } catch (err) {
      console.error('[Asset Manager] Delete error:', err);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'Error: ' + err.message, 'error');
      }
    }
  }

  function cancelDelete() {
    setShowDeleteConfirm(false);
  }

  const handleSaveCustomerNotes = async (updatedNotes) => {

  console.log('[DEBUG SAVE] ===== SAVE CALLED =====');
  console.log('[DEBUG SAVE] Stack trace:', new Error().stack);
  console.log('[DEBUG SAVE] updatedNotes param:', updatedNotes);
  console.log('[DEBUG SAVE] customerNotes state:', customerNotes);
  console.log('[Asset Manager] Saving customer notes to organization:', requesterOrg?.name, 'ID:', requesterOrg?.id);
  console.log('[Asset Manager] Notes content:', updatedNotes);
  
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    alert('Unable to save: No organization found for this user');
    return;
  }

  if (!window.ZAFClient) {
    console.error('[Asset Manager] ZAFClient not available');
    alert('Unable to save: Zendesk client not available');
    return;
  }

  try {
    const client = window.ZAFClient.init();
    
    // Convert notes array to JSON string for storage in custom field
    const notesJson = JSON.stringify(updatedNotes);
    
    // Generate clean plain text for built-in notes field
    const plainTextNotes = updatedNotes.map(note => {
      const emoji = note.priority === 'high' ? '🔴' : note.priority === 'low' ? '🟢' : '🟡';
      const priorityText = note.priority.toUpperCase();
      const date = new Date(note.created_at).toLocaleDateString();
      return `${emoji} ${priorityText}: ${note.text} (Added ${date})`;
    }).join('\n');
    
    console.log('[Asset Manager] Saving structured data to custom field and plain text to notes');
    
    // Try Zendesk API first
    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            notes: plainTextNotes,  // Plain text in built-in field
            organization_fields: {
              customer_notes_data: notesJson  // JSON in custom field
            }
          }
        }
      });
      
      console.log('[Asset Manager] Successfully updated customer notes via Zendesk API for:', requesterOrg.name);
      
      // Update local state
      setCustomerNotes(updatedNotes);  // Update UI immediately
      setRequesterOrg(prev => ({
        ...prev,
        notes: plainTextNotes,
        organization_fields: {
          ...prev.organization_fields,
          customer_notes_data: notesJson
        }
      }));
      
      await client.invoke('notify', `Customer notes updated for ${requesterOrg.name}`);
      return;
      
    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API update failed, trying backend:', zendeskError);
    }

    // Fallback to backend API
    const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        notes: plainTextNotes,
        organization_fields: {
          customer_notes_data: notesJson
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend API failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    console.log('[Asset Manager] Backend update successful for:', requesterOrg.name, result);
    
    // Update local state
    setRequesterOrg(prev => ({
      ...prev,
      notes: plainTextNotes,
      organization_fields: {
        ...prev.organization_fields,
        customer_notes_data: notesJson
      }
    }));
    
    await client.invoke('notify', `Customer notes updated for ${requesterOrg.name}`);
    
  } catch (error) {
    console.error('[Asset Manager] Error saving customer notes for org:', requesterOrg?.name, error);
    alert('Error saving customer notes: ' + error.message);
  }
};

// Known Issues save handler
// Load the current ticket ID and the agents + groups for the escalation
// "Assign To" dropdown. Uses the ZAF client (runs as the signed-in agent).
const loadEscalationContext = async (client) => {
  try {
    const idData = await client.get('ticket.id');
    const tid = idData && idData['ticket.id'];
    if (tid) {
      setTicketId(tid);
      console.log('[Escalation] Active ticket ID:', tid);
    }
  } catch (err) {
    console.log('[Escalation] Could not read ticket ID:', err);
  }

  // Read ticket subject + description for IT Portal asset highlighting.
  try {
    const txt = await client.get(['ticket.subject', 'ticket.description']);
    const subject = (txt && txt['ticket.subject']) || '';
    const description = (txt && txt['ticket.description']) || '';
    setTicketText(`${subject}\n${description}`.toLowerCase());
    console.log('[Asset Manager] Ticket text loaded for asset matching');

    // Parse the alarm's own fields so "Mute this alarm" can prefill from clean,
    // canonical values instead of the agent hand-typing (which is how the first
    // mute ended up with a full pasted line and en-dashes that never matched).
    // Same field vocabulary as the n8n matcher.
    const alarmField = (name) => {
      const m = description.match(
        new RegExp(`(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:\\t]?\\s*(.+)`, 'i')
      );
      return m ? m[1].trim() : '';
    };
    // FQDN is the stable per-host identifier — prefer "Asset FQDN" if present,
    // else fall back to pulling the first hostname out of Device Name.
    let fqdn = alarmField('Asset FQDN');
    if (!fqdn) {
      const dn = alarmField('Device Name');
      const hostMatch = dn.match(/([a-z0-9][a-z0-9.\-]*\.[a-z]{2,})/i);
      fqdn = hostMatch ? hostMatch[1] : '';
    }
    setParsedAlarm({
      isAlarm: /(^|\n)\s*(?:\*\*)?(?:Maint Object|Device Name)\b/i.test(description),
      company:   alarmField('Company'),
      fqdn:      fqdn,
      alarmType: alarmField('Maint Object'),
      site:      alarmField('Site') || alarmField('Device Location')
    });
  } catch (err) {
    console.log('[Asset Manager] Could not read ticket subject/description:', err);
  }

  try {
    // Restricted escalation assignees: allowed groups with members nested
    const resp = await fetch(`${BACKEND_BASE_URL}/api/escalation-assignees`).then(r => r.json());
    setAssigneeOptions(resp.groups || []);
    console.log('[Escalation] Loaded', (resp.groups || []).length, 'assignee groups');
  } catch (err) {
    console.error('[Escalation] Error loading assignee options:', err);
  }

  try {
    // Custom ticket statuses for the Status dropdown
    const statusResp = await fetch(`${BACKEND_BASE_URL}/api/custom-statuses`).then(r => r.json());
    setStatusOptions(statusResp.statuses || []);
    console.log('[Escalation] Loaded', (statusResp.statuses || []).length, 'custom statuses');
  } catch (err) {
    console.error('[Escalation] Error loading custom statuses:', err);
  }
};

// Escalate the current ticket: set priority, status, assignee, and add an
// internal note. Applied via the ZAF client so the note/audit entry is
// attributed to the signed-in agent.
const handleEscalate = async () => {
  if (!ticketId) {
    alert('No active ticket to escalate.');
    return;
  }
  if (!window.ZAFClient) {
    alert('Unable to proceed: Zendesk client not available.');
    return;
  }

  // ---- Reject mode: bounce the ticket back to the original assignee/group ----
  if (escalationForm.rejectMode) {
    if (!escalationForm.rejectReason) {
      alert('Please select a rejection reason.');
      return;
    }
    if (escalationForm.rejectReason === 'Other' && !(escalationForm.rejectReasonOther || '').trim()) {
      alert('Please describe the reason for rejection.');
      return;
    }
    if (!(escalationForm.comment || '').trim()) {
      alert('Please add notes for the rejection.');
      return;
    }

    setIsEscalating(true);
    const client = window.ZAFClient.init();
    const ORIGINAL_ASSIGNEE_FIELD_ID = 22532111260055; // Lookup (stores user id)
    const ORIGINAL_GROUP_FIELD_ID = 22532310932375;    // Numeric (stores group id)

    try {
      // Read the original assignee/group captured at escalation time.
      let originalAssignee = null;
      let originalGroup = null;
      try {
        const fieldData = await client.get([
          `ticket.customField:custom_field_${ORIGINAL_ASSIGNEE_FIELD_ID}`,
          `ticket.customField:custom_field_${ORIGINAL_GROUP_FIELD_ID}`,
        ]);
        originalAssignee = fieldData && fieldData[`ticket.customField:custom_field_${ORIGINAL_ASSIGNEE_FIELD_ID}`];
        originalGroup = fieldData && fieldData[`ticket.customField:custom_field_${ORIGINAL_GROUP_FIELD_ID}`];
      } catch (e) {
        console.log('[Rejection] Could not read original assignee/group fields', e);
      }

      const rejectReason = escalationForm.rejectReason === 'Other'
        ? (escalationForm.rejectReasonOther || '').trim()
        : escalationForm.rejectReason;

      let rejectingAgent = '';
      try {
        const me = await client.get('currentUser');
        rejectingAgent = (me && me.currentUser && me.currentUser.name) || '';
      } catch (e) { rejectingAgent = ''; }

      const SEP = '────────────────────────────';
      const lines = [];
      lines.push('ESCALATION REJECTED');
      lines.push(SEP);
      lines.push(`TICKET ID#: ${ticketId}`);
      if (rejectingAgent) lines.push(`REJECTED BY: ${rejectingAgent}`);
      lines.push(SEP);
      lines.push('');
      lines.push('This escalation has been returned to the original assignee.');
      lines.push('');
      lines.push('REASON FOR REJECTION:');
      lines.push(rejectReason || '(not specified)');
      lines.push('');
      lines.push('NOTES:');
      lines.push(escalationForm.comment.trim());

      const ticketUpdate = {
        comment: { body: lines.join('\n'), public: false },
        status: 'open',
      };

      // Route back to whoever/whatever was captured. Numeric coercion guards
      // against string values from the custom fields.
      const assigneeId = parseInt(originalAssignee, 10);
      const groupId = parseInt(originalGroup, 10);
      if (!isNaN(assigneeId)) ticketUpdate.assignee_id = assigneeId;
      if (!isNaN(groupId)) ticketUpdate.group_id = groupId;

      // Fallback: if no original assignee was captured but the rejecting agent
      // picked someone in the assignee dropdown, honor that.
      if (isNaN(assigneeId) && isNaN(groupId) && escalationForm.assigneeValue) {
        const [kind, id] = escalationForm.assigneeValue.split(':');
        if (kind === 'group') ticketUpdate.group_id = parseInt(id, 10);
        else if (kind === 'agent') ticketUpdate.assignee_id = parseInt(id, 10);
      }

      await client.request({
        url: `/api/v2/tickets/${ticketId}.json`,
        type: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify({ ticket: ticketUpdate }),
      });

      console.log('[Rejection] Ticket returned via API:', ticketUpdate);
      await client.invoke('notify', 'Escalation rejected and returned to the original assignee.', 'notice');

      setEscalationForm({
        reason: '', reasonOther: '', severity: '', stepsToReproduce: '',
        troubleshootingTaken: '', engageSpeed: '', status: '',
        assigneeValue: '', comment: '', astType: '', bridge: '',
        rejectMode: false, rejectReason: '', rejectReasonOther: ''
      });
      setEscalationSectionExpanded(false);
    } catch (err) {
      const detail = (err && err.message) || 'Unknown error';
      try { await client.invoke('notify', 'Error rejecting escalation: ' + detail, 'error'); }
      catch (_) { alert('Error rejecting escalation: ' + detail); }
    } finally {
      setIsEscalating(false);
    }
    return;
  }
  // ---- End reject mode ----

  if (!escalationForm.reason) {
    alert('Please select a reason for escalation.');
    return;
  }
  if (escalationForm.reason === 'Other' && !(escalationForm.reasonOther || '').trim()) {
    alert('Please describe the reason for escalation.');
    return;
  }
  if (!escalationForm.severity) {
    alert('Please select the current severity.');
    return;
  }
  if (!escalationForm.engageSpeed) {
    alert('Please select how fast someone needs to engage.');
    return;
  }
  if (!(escalationForm.comment || '').trim()) {
    alert('Please add notes for the escalation.');
    return;
  }

  setIsEscalating(true);
  const client = window.ZAFClient.init();

  const SEVERITY_FIELD_ID = 21523698949271; // Zendesk "Severity" custom field
  const AST_TYPE_FIELD_ID = 41174484217751; // Zendesk "AST Type" custom field (Advanced Services)
  const AST_TYPE_LABELS = {
    escalation_request: 'Escalation Request',
    certificate_management: 'Certificate Management',
    license_management: 'License Management',
    advanced_troubleshooting: 'Advanced Troubleshooting',
    software_release_management: 'Software Release Management',
    macd: 'MACD',
    try_buy: 'Try & Buy',
  };
  const SEVERITY_TO_PRIORITY = { sev1: 'urgent', sev2: 'high', sev3: 'normal', sev4: 'low' };
  const SEVERITY_LABELS = {
    sev1: 'SEV1 — Critical Outage',
    sev2: 'SEV2 — Urgent (>25% impact)',
    sev3: 'SEV3 — Important (<25% impact)',
    sev4: 'SEV4 — Minor'
  };

  // Resolve the reason (free text when "Other" is selected).
  const resolvedReason =
    escalationForm.reason === 'Other'
      ? (escalationForm.reasonOther || '').trim()
      : escalationForm.reason;

  // Look up the reporting agent (the signed-in user) for the header block.
  let reportingAgent = '';
  try {
    const me = await client.get('currentUser');
    reportingAgent = (me && me.currentUser && me.currentUser.name) || '';
  } catch (e) {
    reportingAgent = '';
  }

  // Assemble contact + company lines from requester data.
  const contactParts = [];
  if (requester?.name) contactParts.push(requester.name);
  if (requester?.email) contactParts.push(requester.email);
  if (requester?.phone) contactParts.push(requester.phone);
  const contactLine = contactParts.join(' / ');
  const companyName = requesterOrg?.name || '';

  const SEP = '────────────────────────────';

  // Compose a structured internal note modeled on the legacy escalation macro.
  // (Note: Zendesk API comments are plain text — no bold/color/links.)
  const noteLines = [];
  noteLines.push('TICKET ESCALATED');
  noteLines.push(SEP);
  noteLines.push(`TICKET ID#: ${ticketId}`);
  if (reportingAgent) noteLines.push(`REPORTING AGENT: ${reportingAgent}`);
  if (contactLine) noteLines.push(`CONTACT: ${contactLine}`);
  if (companyName) noteLines.push(`COMPANY: ${companyName}`);
  noteLines.push(SEP);
  noteLines.push('');
  noteLines.push('This ticket has been escalated for review. Please review all');
  noteLines.push('details below before reassigning or actioning the ticket.');
  noteLines.push('');

  noteLines.push('REASON FOR ESCALATION:');
  noteLines.push(resolvedReason || '(not specified)');
  noteLines.push('');

  noteLines.push('CURRENT SEVERITY:');
  noteLines.push(SEVERITY_LABELS[escalationForm.severity] || escalationForm.severity);
  noteLines.push('');

  if (escalationForm.astType) {
    noteLines.push('AST TYPE:');
    noteLines.push(AST_TYPE_LABELS[escalationForm.astType] || escalationForm.astType);
    noteLines.push('');
  }

  if (escalationForm.stepsToReproduce && escalationForm.stepsToReproduce.trim()) {
    noteLines.push('STEPS TO REPRODUCE:');
    noteLines.push(escalationForm.stepsToReproduce.trim());
    noteLines.push('');
  }

  if (escalationForm.troubleshootingTaken && escalationForm.troubleshootingTaken.trim()) {
    noteLines.push('TROUBLESHOOTING STEPS ALREADY TAKEN:');
    noteLines.push(escalationForm.troubleshootingTaken.trim());
    noteLines.push('');
  }

  noteLines.push('HOW FAST DOES SOMEONE NEED TO ENGAGE:');
  noteLines.push(escalationForm.engageSpeed);
  noteLines.push('');

  if (escalationForm.bridge && escalationForm.bridge.trim()) {
    noteLines.push('ESCALATION BRIDGE:');
    noteLines.push(escalationForm.bridge.trim());
    noteLines.push('');
  }

  noteLines.push('ADDITIONAL NOTES:');
  noteLines.push(escalationForm.comment.trim());

  // Stage ALL escalation values into the OPEN ticket form via ZAF. Nothing is
  // written to the server here — the agent's single native Submit commits
  // everything at once (these fields + any reply/edits they made), exactly like
  // the old macro. Confirmed the severity custom-field form-setter works in this
  // instance, so all five fields stage consistently and none save early.
  const noteBody = noteLines.join('\n');
  const priorityValue = SEVERITY_TO_PRIORITY[escalationForm.severity] || 'high';

  // Capture the CURRENT assignee/group before we reassign, so a later rejection
  // can return the ticket to where it came from. Falls back to the current user
  // (the escalating engineer) when the ticket is unassigned.
  const ORIGINAL_ASSIGNEE_FIELD_ID = 22532111260055; // Lookup (stores user id)
  const ORIGINAL_GROUP_FIELD_ID = 22532310932375;    // Numeric (stores group id)
  let originalAssigneeId = null;
  let originalGroupId = null;
  try {
    const cur = await client.get(['ticket.assignee.user.id', 'ticket.assignee.group.id']);
    originalAssigneeId = cur && cur['ticket.assignee.user.id'];
    originalGroupId = cur && cur['ticket.assignee.group.id'];
  } catch (e) {
    console.log('[Escalation] Could not read current assignee/group', e);
  }
  if (!originalAssigneeId) {
    try {
      const me = await client.get('currentUser');
      originalAssigneeId = (me && me.currentUser && me.currentUser.id) || null;
    } catch (e) { /* leave null */ }
  }

  try {
    // Build the ticket update. All fields commit server-side in ONE PUT via the
    // ZAF authenticated API proxy — same pattern used for org notes elsewhere in
    // this app. Escalation is self-contained, so the Escalate button is the only
    // action; there is no native Submit step. Custom status and assignee are set
    // here via the REST API because the ZAF form-setter paths for them are
    // invalid in this Zendesk instance.
    const ticketUpdate = {
      // Internal note (plain text). public:false makes it an internal note.
      comment: { body: noteBody, public: false },
      // Priority derived from severity.
      priority: priorityValue,
      // Severity custom field.
      custom_fields: [
        { id: SEVERITY_FIELD_ID, value: escalationForm.severity },
      ],
    };

    // Custom status (if chosen).
    if (escalationForm.status) {
      ticketUpdate.custom_status_id = parseInt(escalationForm.status, 10);
    }

    // AST Type (Advanced Services) — only set when chosen.
    if (escalationForm.astType) {
      ticketUpdate.custom_fields.push({ id: AST_TYPE_FIELD_ID, value: escalationForm.astType });
    }

    // Capture original assignee/group so a later rejection can return the ticket.
    if (originalAssigneeId) {
      ticketUpdate.custom_fields.push({ id: ORIGINAL_ASSIGNEE_FIELD_ID, value: originalAssigneeId });
    }
    if (originalGroupId) {
      ticketUpdate.custom_fields.push({ id: ORIGINAL_GROUP_FIELD_ID, value: originalGroupId });
    }

    // Assignee — group or specific agent.
    if (escalationForm.assigneeValue) {
      const [kind, id] = escalationForm.assigneeValue.split(':');
      if (kind === 'group') {
        ticketUpdate.group_id = parseInt(id, 10);
      } else if (kind === 'agent') {
        ticketUpdate.assignee_id = parseInt(id, 10);
      }
    }

    await client.request({
      url: `/api/v2/tickets/${ticketId}.json`,
      type: 'PUT',
      contentType: 'application/json',
      data: JSON.stringify({ ticket: ticketUpdate }),
    });

    console.log('[Escalation] Ticket updated via API:', ticketUpdate);

    await client.invoke('notify', 'Ticket escalated successfully.', 'notice');

    setEscalationForm({
      reason: '', reasonOther: '', severity: '', stepsToReproduce: '',
      troubleshootingTaken: '', engageSpeed: '', status: '',
      assigneeValue: '', comment: '', astType: '', bridge: '',
      rejectMode: false, rejectReason: '', rejectReasonOther: ''
    });
    setEscalationSectionExpanded(false);
  } catch (err) {
    const detail = (err && err.message) || 'Unknown error';
    try {
      await client.invoke('notify', 'Error escalating ticket: ' + detail, 'error');
    } catch (_) {
      alert('Error escalating ticket: ' + detail);
    }
  } finally {
    setIsEscalating(false);
  }
};

const handleSaveKnownIssues = async (updatedIssues) => {
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    return;
  }

  try {
    const client = window.ZAFClient.init();
    
    // Update local state first
    setKnownIssues(updatedIssues);
    
    // Try Zendesk API first
    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            organization_fields: {
              known_issues: JSON.stringify(updatedIssues)
            }
          }
        }
      });
      
      console.log('[Asset Manager] Successfully updated known issues via Zendesk API');
      await client.invoke('notify', 'Known issues updated');
      
    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API failed, trying backend');
      // Fallback to backend API
      const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_fields: {
            ...requesterOrg.organization_fields,
            known_issues: JSON.stringify(updatedIssues)
          }
        })
      });

      if (!response.ok) throw new Error(`Backend API failed: ${response.status}`);
    }
    
  } catch (error) {
    console.error('[Asset Manager] Error saving known issues:', error);
    alert('Error saving known issues: ' + error.message);
    // Revert on error
    setKnownIssues(knownIssues);
  }
};

// =====================================================================
// Auto CC save — three-way merge (replaces the blind-overwrite version)
//
// The old handler PUT whatever was in React state, so a card holding a
// stale array silently reverted the org field. Real incident: 7 rules were
// repaired in the field, a save from a stale tab wrote 6, one recipient
// vanished with no error.
//
// This version merges: base (what this card hydrated) vs next (what the
// agent just did) vs remote (what is stored right now). Only the agent's
// actual changes are applied; rules touched by someone else are preserved.
//
// Requires CC_RULE_KEY and fetchStoredCcRules (below) in scope.
// =====================================================================

// Identity for a rule. Matches ruleKey() in the n8n Digest Core node —
// keep the two in sync or digest state keys will drift.
const CC_RULE_KEY = (r) => String(r?.id || r?.email || '').trim().toLowerCase();

// Read the rules as currently stored. Never assume; a save that can't see
// the current value is exactly what caused the incident.
//   -> { status: 'ok', rules }          readable and parseable
//   -> { status: 'unparseable', raw }   field is corrupt (e.g. Ruby to_s)
//   -> { status: 'unreadable' }         both API paths failed
const fetchStoredCcRules = async (client, orgId) => {
  let raw = null;

  try {
    const res = await client.request({
      url: `/api/v2/organizations/${orgId}.json`,
      type: 'GET'
    });
    raw = res?.organization?.organization_fields?.auto_cc_rules ?? '';
  } catch (zafErr) {
    console.log('[Asset Manager] ZAF org read failed, trying backend', zafErr);
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/api/organizations/${orgId}`);
      if (!res.ok) throw new Error(`Backend read failed: ${res.status}`);
      const body = await res.json();
      raw = body?.organization_fields?.auto_cc_rules
         ?? body?.organization?.organization_fields?.auto_cc_rules
         ?? '';
    } catch (backendErr) {
      console.error('[Asset Manager] Could not read stored auto CC rules', backendErr);
      return { status: 'unreadable' };
    }
  }

  if (!raw) return { status: 'ok', rules: [] };

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return { status: 'unparseable', raw };
    return { status: 'ok', rules: parsed };
  } catch (e) {
    return { status: 'unparseable', raw };
  }
};

const handleSaveAutoCcRules = async (updatedRules) => {
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    return;
  }

  // Capture before mutating so the error path reverts to the real prior value.
  // This is also the merge BASE: the state this card hydrated from.
  const previousRules = autoCcRules;

  try {
    const client = window.ZAFClient.init();

    // Strip the transient `legacy` marker before persisting.
    const clean = (updatedRules || []).map(({ legacy, ...rest }) => rest);
    const base  = (previousRules || []).map(({ legacy, ...rest }) => rest);

    // ---- Read what is actually stored, then merge against it ----
    const stored = await fetchStoredCcRules(client, requesterOrg.id);

    if (stored.status === 'unreadable') {
      // Refuse to write blind. A failed save is recoverable; an overwrite is not.
      alert(
        'Could not read the current CC rules from Zendesk, so this save was ' +
        'cancelled to avoid overwriting them. Check your connection and try again.'
      );
      setAutoCcRules(previousRules);
      return;
    }

    if (stored.status === 'unparseable') {
      // The stored value is corrupt. Merging is impossible; require explicit consent.
      const proceed = window.confirm(
        'The stored CC rules for this organization are corrupt and cannot be read.\n\n' +
        'Saving now will REPLACE them entirely with what is shown in this card. ' +
        'Any rule not visible here will be lost.\n\n' +
        'Continue?'
      );
      if (!proceed) {
        setAutoCcRules(previousRules);
        return;
      }
      console.warn('[Asset Manager] Overwriting corrupt auto_cc_rules by operator consent:', stored.raw);
    }

    const remote = stored.status === 'ok' ? stored.rules : [];

    const baseMap = new Map(base.map(r => [CC_RULE_KEY(r), r]));
    const nextMap = new Map(clean.map(r => [CC_RULE_KEY(r), r]));

    // Rules this agent deleted: present in base, absent from next.
    const deletedKeys = new Set([...baseMap.keys()].filter(k => !nextMap.has(k)));

    // Rules this agent added or actually modified. Unchanged rules are NOT
    // upserted, so a rule another agent deleted meanwhile stays deleted.
    const changed = clean.filter(r => {
      const k = CC_RULE_KEY(r);
      const before = baseMap.get(k);
      return !before || JSON.stringify(before) !== JSON.stringify(r);
    });
    const changedMap = new Map(changed.map(r => [CC_RULE_KEY(r), r]));

    // Start from remote (preserving its order and anything we've never seen),
    // drop this agent's deletions, apply this agent's edits in place.
    const merged = [];
    const seen = new Set();
    for (const r of remote) {
      const k = CC_RULE_KEY(r);
      if (deletedKeys.has(k)) continue;
      if (seen.has(k)) continue; // defensive: collapse pre-existing dupes
      seen.add(k);
      merged.push(changedMap.has(k) ? changedMap.get(k) : r);
    }
    // Genuinely new rules land at the end.
    for (const r of changed) {
      const k = CC_RULE_KEY(r);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(r);
    }

    const droppedByMerge = clean.length - merged.length;
    if (droppedByMerge !== 0) {
      console.log(
        `[Asset Manager] Auto CC merge: card had ${clean.length}, stored had ${remote.length}, ` +
        `writing ${merged.length} (deleted ${deletedKeys.size}, changed ${changed.length})`
      );
    }

    // Reflect the merged truth, not just this card's view.
    setAutoCcRules(merged);

    // Do NOT blank the legacy `auto_cc` field here. The Zendesk trigger
    // "N8N - Auto_CC" fires the webhook only when Organization > auto_cc is
    // Present — clearing it silently stops the entire CC workflow for that org.
    // n8n ignores auto_cc whenever auto_cc_rules has content, so leaving it
    // populated costs nothing.
    const fields = {
      auto_cc_rules: JSON.stringify(merged)
    };

    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            organization_fields: fields
          }
        }
      });

      console.log('[Asset Manager] Successfully updated auto CC rules via Zendesk API');
      await client.invoke('notify', 'Alarm recipients updated');

    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API failed, trying backend');
      const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_fields: {
            ...requesterOrg.organization_fields,
            ...fields
          }
        })
      });

      if (!response.ok) throw new Error(`Backend API failed: ${response.status}`);
    }

  } catch (error) {
    console.error('[Asset Manager] Error saving auto CC rules:', error);
    alert('Error saving auto CC rules: ' + error.message);
    setAutoCcRules(previousRules);
  }
};

const handleSaveSuppressions = async (updatedSuppressions) => {
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    return;
  }

  const previous = suppressions;

  try {
    const client = window.ZAFClient.init();
    const clean = updatedSuppressions || [];

    setSuppressions(clean);

    const fields = { auto_cc_blocked: JSON.stringify(clean) };

    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            organization_fields: fields
          }
        }
      });

      console.log('[Asset Manager] Successfully updated suppressed alarms via Zendesk API');
      await client.invoke('notify', 'Suppressed alarms updated');

    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API failed, trying backend');
      const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_fields: {
            ...requesterOrg.organization_fields,
            ...fields
          }
        })
      });

      if (!response.ok) throw new Error(`Backend API failed: ${response.status}`);
    }

  } catch (error) {
    console.error('[Asset Manager] Error saving suppressed alarms:', error);
    alert('Error saving suppressed alarms: ' + error.message);
    setSuppressions(previous);
  }
};

const handleSaveEscalationContacts = async (updatedContacts) => {
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    return;
  }

  const previous = escalationContacts;

  try {
    const client = window.ZAFClient.init();
    const clean = updatedContacts || [];

    setEscalationContacts(clean);

    const fields = { escalation_contacts: JSON.stringify(clean) };

    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            organization_fields: fields
          }
        }
      });

      console.log('[Asset Manager] Successfully updated escalation contacts via Zendesk API');
      await client.invoke('notify', 'Escalation contacts updated');

    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API failed, trying backend');
      const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_fields: {
            ...requesterOrg.organization_fields,
            ...fields
          }
        })
      });

      if (!response.ok) throw new Error(`Backend API failed: ${response.status}`);
    }

  } catch (error) {
    console.error('[Asset Manager] Error saving escalation contacts:', error);
    alert('Error saving escalation contacts: ' + error.message);
    setEscalationContacts(previous);
  }
};

const handleSaveEscalationProcedure = async (text) => {
  if (!requesterOrg?.id) {
    console.error('[Asset Manager] No organization ID available');
    return;
  }

  const previous = escalationProcedure;
  const clean = String(text || '');

  try {
    const client = window.ZAFClient.init();

    setEscalationProcedure(clean);

    const fields = { escalation_procedure: clean };

    try {
      await client.request({
        url: `/api/v2/organizations/${requesterOrg.id}.json`,
        type: 'PUT',
        data: {
          organization: {
            organization_fields: fields
          }
        }
      });

      console.log('[Asset Manager] Successfully updated escalation procedure via Zendesk API');
      await client.invoke('notify', 'Escalation procedure updated');

    } catch (zendeskError) {
      console.log('[Asset Manager] Zendesk API failed, trying backend');
      const response = await fetch(`${BACKEND_BASE_URL}/api/organizations/${requesterOrg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_fields: {
            ...requesterOrg.organization_fields,
            ...fields
          }
        })
      });

      if (!response.ok) throw new Error(`Backend API failed: ${response.status}`);
    }

  } catch (error) {
    console.error('[Asset Manager] Error saving escalation procedure:', error);
    alert('Error saving escalation procedure: ' + error.message);
    setEscalationProcedure(previous);
  }
};

  function handleItPortalAssetClick(asset) {
    console.log('[Asset Manager] IT Portal asset clicked:', asset);
    setSelectedItPortalAsset(asset);
    // Initialize form data with current asset values
    setItPortalFormData({
      type: asset.device_type || asset.type || '',
      name: asset.name || asset.asset_tag || '',
      host_name: asset.host_name || asset.hostname || '',
      description: asset.description || '',
      domain: asset.domain || asset.realm || '',
      facility: asset.facility || asset.location || '',
      username: asset.username || asset.assigned_user || '',
      preferred_access: asset.preferred_access || asset.access_method || ''
    });
    setEditingItPortalAsset(false);
  }

  function handleItPortalAssetBack() {
    console.log('[Asset Manager] Going back to IT Portal asset list');
    setSelectedItPortalAsset(null);
    setItPortalFormData({});
    setEditingItPortalAsset(false);
  }

  function handleStartEditItPortalAsset() {
    console.log('[Asset Manager] Starting to edit IT Portal asset');
    setEditingItPortalAsset(true);
  }

  function handleCancelEditItPortalAsset() {
    console.log('[Asset Manager] Canceling IT Portal asset edit');
    // Reset form data to original values
    setItPortalFormData({
      type: selectedItPortalAsset.device_type || selectedItPortalAsset.type || '',
      name: selectedItPortalAsset.name || selectedItPortalAsset.asset_tag || '',
      host_name: selectedItPortalAsset.host_name || selectedItPortalAsset.hostname || '',
      description: selectedItPortalAsset.description || '',
      domain: selectedItPortalAsset.domain || selectedItPortalAsset.realm || '',
      facility: selectedItPortalAsset.facility || selectedItPortalAsset.location || '',
      username: selectedItPortalAsset.username || selectedItPortalAsset.assigned_user || '',
      preferred_access: selectedItPortalAsset.preferred_access || selectedItPortalAsset.access_method || ''
    });
    setEditingItPortalAsset(false);
  }

  async function handleSaveItPortalAsset() {
    if (!selectedItPortalAsset) return;
    
    console.log('[Asset Manager] Saving IT Portal asset:', selectedItPortalAsset.id, itPortalFormData);
    
    try {
      // Map form data back to API format
      const payload = {
        device_type: itPortalFormData.type,
        name: itPortalFormData.name,
        host_name: itPortalFormData.host_name,
        hostname: itPortalFormData.host_name, // Fallback field
        description: itPortalFormData.description,
        domain: itPortalFormData.domain,
        realm: itPortalFormData.domain, // Fallback field
        facility: itPortalFormData.facility,
        location: itPortalFormData.facility, // Fallback field
        username: itPortalFormData.username,
        assigned_user: itPortalFormData.username, // Fallback field
        preferred_access: itPortalFormData.preferred_access,
        access_method: itPortalFormData.preferred_access // Fallback field
      };

      const response = await fetch(`${BACKEND_BASE_URL}/api/it-portal-assets/${selectedItPortalAsset.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update IT Portal asset (${response.status}): ${errorText}`);
      }

      const updatedAsset = await response.json();
      console.log('[Asset Manager] IT Portal asset updated successfully:', updatedAsset);

      // Update the asset in the local state
      setItPortalAssets(prevAssets => 
        prevAssets.map(asset => 
          asset.id === selectedItPortalAsset.id 
            ? { ...asset, ...payload } 
            : asset
        )
      );

      // Update the selected asset with new data
      setSelectedItPortalAsset({ ...selectedItPortalAsset, ...payload });
      
      setEditingItPortalAsset(false);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'IT Portal asset updated successfully!', 'notice');
      } else {
        alert('IT Portal asset updated successfully!');
      }
      
    } catch (err) {
      console.error('[Asset Manager] Error updating IT Portal asset:', err);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'Error updating IT Portal asset: ' + err.message, 'error');
      } else {
        alert('Error updating IT Portal asset: ' + err.message);
      }
    }
  }

  function handleBack() {
    console.log('[Asset Manager] Going back to asset list');
    setSelectedAsset(null);
  }

  if (loading) {
    console.log('[Asset Manager] Still loading...');
    return (
      <div style={{ 
        fontFamily: "sans-serif", 
        padding: "20px",
        textAlign: "center",
        color: "#68737D",
        fontSize: "14px"
      }}>
        Loading asset information...
      </div>
    );
  }

  console.log('[Asset Manager] Rendering main app. Assets count:', assets.length);

  return (
    <div style={{ 
      fontFamily: '"Zendesk Garden", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: "#F8F9FA",
      padding: "8px",
      color: "#2F3941",
      fontSize: "12px",
      lineHeight: "1.4"
    }}>

      {/* 1. Requester Information Card */}
      <div style={{
        backgroundColor: '#FFFFFF',
        border: '1px solid #D8DCDE',
        borderRadius: '0',
        borderBottom: 'none',
        marginBottom: '0px',
        boxShadow: 'none'
      }}>
        <div
          onClick={() => setRequesterSectionExpanded(!requesterSectionExpanded)}
          style={{
            cursor: "pointer",
            padding: "10px 12px",
            minHeight: '35px',
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: requesterSectionExpanded ? '1px solid #D8DCDE' : 'none'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, borderRadius: 8,
              backgroundColor: '#EAF2FB', flexShrink: 0
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
              Requester Information
            </span>
          </div>
          <span style={{ color: '#68737D', fontSize: '12px' }}>
            {requesterSectionExpanded ? "▼" : "▶"}
          </span>
        </div>
        
        {requesterSectionExpanded && (
          <div style={{ padding: "12px" }}>
            {requester ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', fontSize: '12px' }}>
                  <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Name:</span>
                  <span style={{ color: '#2F3941' }}>{requester.name}</span>
                </div>
                <div style={{ display: 'flex', fontSize: '12px' }}>
                  <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Email:</span>
                  <span style={{ color: '#2F3941' }}>{requester.email}</span>
                </div>
                <div style={{ display: 'flex', fontSize: '12px' }}>
                  <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>User ID:</span>
                  <span style={{ color: '#2F3941', fontFamily: 'monospace' }}>{requester.id}</span>
                </div>
                <div style={{ display: 'flex', fontSize: '12px' }}>
                  <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Role:</span>
                  <span style={{ color: '#2F3941' }}>{requester.role}</span>
                </div>
                <div style={{ display: 'flex', fontSize: '12px' }}>
                  <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Phone:</span>
                  <span style={{ color: '#2F3941' }}>{requester.phone || "Not provided"}</span>
                </div>
                {requesterOrg && (
                  <div style={{ 
                    marginTop: '12px', 
                    paddingTop: '12px', 
                    borderTop: '1px solid #D8DCDE' 
                  }}>
                    <div style={{ display: 'flex', fontSize: '12px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Org:</span>
                      <span style={{ color: '#2F3941' }}>{requesterOrg.name}</span>
                    </div>
                    {requesterOrg.domain_names?.length > 0 && (
                      <div style={{ display: 'flex', fontSize: '12px', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Domain:</span>
                        <span style={{ color: '#2F3941' }}>{requesterOrg.domain_names.join(', ')}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', fontSize: '12px' }}>
                      <span style={{ fontWeight: '600', color: '#68737D', minWidth: '80px' }}>Rep:</span>
                      <span style={{ color: '#2F3941' }}>{
                        requesterOrg?.organization_fields?.sales_rep || 
                        requester?.user_fields?.sales_rep || 
                        "Not assigned"
                      }</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: '#68737D', textAlign: 'center', fontSize: '12px' }}>
                No requester information available
              </div>
            )}
          </div>
        )}
      </div>

      {!selectedAsset && (
        <div>

          {/* 2. Active Subscriptions Card */}
          <div style={{
            backgroundColor: '#FFFFFF',
            border: '1px solid #D8DCDE',
            borderRadius: '0',
            marginBottom: '0px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
          }}>
            <div
              onClick={() => setSubscriptionsSectionExpanded(!subscriptionsSectionExpanded)}
              style={{
                cursor: "pointer",
                padding: "8px 12px",
                minHeight: '35px',
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: subscriptionsSectionExpanded ? '1px solid #D8DCDE' : 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 32, height: 32, borderRadius: 8,
                    backgroundColor: '#EAF2FB', flexShrink: 0
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                      stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="20" x2="12" y2="10" />
                      <line x1="18" y1="20" x2="18" y2="4" />
                      <line x1="6" y1="20" x2="6" y2="16" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941', whiteSpace: 'nowrap' }}>
                    Active Subscriptions ({subscriptions.length})
                  </span>
                </div>
                
                {/* Badge: Show Partner Badge (Sangoma/Intermedia) OR Visualize Badge */}
              {(() => {
                // Check for partner badge first (takes priority)
                const partnerBadge = getPartnerBadge(requesterOrg, subscriptions);
                
                // If partner badge exists, show only that
                if (partnerBadge) {
                  return (
                    <div style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: partnerBadge.bg,
                      color: partnerBadge.color,
                      padding: '4px 10px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: '600',
                      textTransform: 'uppercase',
                      letterSpacing: '0.3px',
                      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
                      minWidth: '65px'
                    }}>
                      {partnerBadge.name}
                    </div>
                  );
                }
                
                // Otherwise, show Visualize support level badge
                const supportInfo = getSupportLevel(requesterOrg, subscriptions);
                if (!supportInfo) return null;
                
                return (
                  <div style={{
                    display: 'inline-flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: supportInfo.bg,
                    color: supportInfo.color,
                    padding: supportInfo.tier ? '6px 10px' : '3px 6px',
                    borderRadius: '6px',
                    border: supportInfo.border || `1px solid ${supportInfo.color}20`,
                    outline: 'none',
                    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
                    minWidth: supportInfo.tier ? '70px' : 'auto'
                  }}>
                    {supportInfo.tier && (
                      <span style={{ 
                        fontSize: '9px', 
                        fontWeight: '500',
                        lineHeight: '1',
                        opacity: 0.8,
                        textTransform: 'uppercase',
                        letterSpacing: '0.3px'
                      }}>
                        {supportInfo.tier}
                      </span>
                    )}
                    <span style={{ 
  fontSize: supportInfo.tier ? '13px' : '10px',
  fontWeight: '700',
  lineHeight: '1.1',
  marginTop: supportInfo.tier ? '2px' : '0',
  textTransform: supportInfo.tier ? 'none' : 'uppercase',
  letterSpacing: supportInfo.tier ? 'normal' : '0.3px',
  whiteSpace: 'nowrap'
}}>
  {supportInfo.level}
</span>
                  </div>
                );
              })()}
              
              {/* Visualize Support Documentation Link */}
              <a
                href="https://drive.google.com/file/d/1p4A4bvRF5F0NjH0WZYI3Y2uG_EQlnm3x/view?usp=drive_link"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="View Visualize Support Documentation"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '28px',
                  height: '28px',
                  fontSize: '14px',
                  color: '#1F73B7',
                  backgroundColor: '#E8F5FF',
                  border: '1px solid #1F73B7',
                  borderRadius: '4px',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#D0E7FF';
                  e.currentTarget.style.transform = 'scale(1.05)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#E8F5FF';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                📚
              </a>

              </div>
              <span style={{ color: '#68737D', fontSize: '12px' }}>
                {subscriptionsSectionExpanded ? "▼" : "▶"}
              </span>
            </div>
            
            {subscriptionsSectionExpanded && (
              <div style={{ padding: "12px" }}>
                {subscriptions.length === 0 ? (
                  <div style={{
                    padding: "20px",
                    textAlign: "center",
                    color: "#68737D",
                    fontSize: "12px"
                  }}>
                    No active subscriptions found for this organization.
                    <div style={{
                      fontSize: "11px",
                      color: "#B8B8B8",
                      marginTop: "4px"
                    }}>
                      {requesterOrg ? `Organization: ${requesterOrg.name}` : 'Subscription data integration coming soon'}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {subscriptions.map((subscription, index) => {
                      const subscriptionName = subscription.name || subscription.product_name || "Unknown Subscription";
                      const subscriptionStatus = subscription.status || "Unknown";
                      const nextBillingDate = subscription.next_billing_date || subscription.renewal_date;
                      const monthlyValue = subscription.monthly_value || subscription.price || subscription.amount;
                      
                      return (
                        <div
                          key={subscription.id || `subscription-${index}`}
                          style={{
                            padding: "12px",
                            borderRadius: "6px",
                            border: "1px solid #D8DCDE",
                            backgroundColor: "#F8F9FA",
                            fontSize: "12px"
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                            <div style={{ 
                              fontWeight: "600", 
                              color: "#2F3941",
                              fontSize: "12px"
                            }}>
                              {subscriptionName}
                            </div>
                            <div style={{ 
                              fontSize: "10px",
                              fontWeight: "600",
                              color: subscriptionStatus.toLowerCase() === 'active' ? '#2E7D0F' : 
                                     subscriptionStatus.toLowerCase() === 'cancelled' ? '#CC3340' : '#B54708',
                              backgroundColor: subscriptionStatus.toLowerCase() === 'active' ? '#E8F5E8' : 
                                             subscriptionStatus.toLowerCase() === 'cancelled' ? '#FBEAEA' : '#FFF4CC',
                              padding: "2px 6px",
                              borderRadius: "12px",
                              textTransform: "uppercase"
                            }}>
                              {subscriptionStatus}
                            </div>
                          </div>
                          
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '11px' }}>
                            {monthlyValue && (
                              <div>
                                <span style={{ fontWeight: '600', color: '#68737D' }}>Monthly:</span>
                                <span style={{ color: '#2F3941', marginLeft: '4px' }}>
                                  ${parseFloat(monthlyValue).toFixed(2)}
                                </span>
                              </div>
                            )}
                            
                            {nextBillingDate && (
                              <div>
                                <span style={{ fontWeight: '600', color: '#68737D' }}>Next Billing:</span>
                                <span style={{ color: '#2F3941', marginLeft: '4px' }}>
                                  {new Date(nextBillingDate).toLocaleDateString()}
                                </span>
                              </div>
                            )}
                            
                            {subscription.seats && (
                              <div>
                                <span style={{ fontWeight: '600', color: '#68737D' }}>Seats:</span>
                                <span style={{ color: '#2F3941', marginLeft: '4px' }}>
                                  {subscription.seats}
                                </span>
                              </div>
                            )}
                            
                            {subscription.plan_name && (
                              <div>
                                <span style={{ fontWeight: '600', color: '#68737D' }}>Plan:</span>
                                <span style={{ color: '#2F3941', marginLeft: '4px' }}>
                                  {subscription.plan_name}
                                </span>
                              </div>
                            )}
                          </div>
                          
                          {subscription.description && (
                            <div style={{ 
                              marginTop: '8px', 
                              paddingTop: '8px', 
                              borderTop: '1px solid #D8DCDE',
                              fontSize: '11px',
                              color: '#68737D'
                            }}>
                              {subscription.description}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 3. Customer Notes Card */}
        <CustomerNotesCard
          customerNotes={customerNotes}
          setCustomerNotes={setCustomerNotes}
          customerNotesSectionExpanded={customerNotesSectionExpanded}
          setCustomerNotesSectionExpanded={setCustomerNotesSectionExpanded}
          setShowAddNote={setShowAddNote}
          setEditingNote={setEditingNote}
          setNoteForm={setNoteForm}
          handleSaveCustomerNotes={handleSaveCustomerNotes}
        />

        <CustomerNoteModal
          open={showAddNote}
          onClose={() => { setShowAddNote(false); }}
          noteForm={noteForm}
          setNoteForm={setNoteForm}
          editingNote={editingNote}
          customerNotes={customerNotes}
          handleSaveCustomerNotes={handleSaveCustomerNotes}
          setEditingNote={setEditingNote}
        />

          {/* 4. Known Issues Card */}
          <KnownIssuesCard
            knownIssues={knownIssues}
            setKnownIssues={setKnownIssues}
            knownIssuesSectionExpanded={knownIssuesSectionExpanded}
            setKnownIssuesSectionExpanded={setKnownIssuesSectionExpanded}
            setShowAddIssue={setShowAddIssue}
            setEditingIssue={setEditingIssue}
            setIssueForm={setIssueForm}
            handleSaveKnownIssues={handleSaveKnownIssues}
          />

          <KnownIssueModal
            open={showAddIssue}
            onClose={() => { setShowAddIssue(false); }}
            issueForm={issueForm}
            setIssueForm={setIssueForm}
            editingIssue={editingIssue}
            knownIssues={knownIssues}
            handleSaveKnownIssues={handleSaveKnownIssues}
            setEditingIssue={setEditingIssue}
          />

          {/* 4a. Auto CC Card */}
          <AutoCcCard
            autoCcRules={autoCcRules}
            autoCcSectionExpanded={autoCcSectionExpanded}
            setAutoCcSectionExpanded={setAutoCcSectionExpanded}
            setShowAddCcRule={setShowAddCcRule}
            setEditingCcRule={setEditingCcRule}
            setCcRuleForm={setCcRuleForm}
            handleSaveAutoCcRules={handleSaveAutoCcRules}
            suppressions={suppressions}
            parsedAlarm={parsedAlarm}
          />

          <AutoCcRuleModal
            open={showAddCcRule}
            onClose={() => { setShowAddCcRule(false); }}
            ccRuleForm={ccRuleForm}
            setCcRuleForm={setCcRuleForm}
            editingCcRule={editingCcRule}
            autoCcRules={autoCcRules}
            handleSaveAutoCcRules={handleSaveAutoCcRules}
            setEditingCcRule={setEditingCcRule}
          />

          {/* 4a-ii. Muted Alarms Card */}
          <SuppressedAlarmsCard
            suppressions={suppressions}
            parsedAlarm={parsedAlarm}
            suppressSectionExpanded={suppressSectionExpanded}
            setSuppressSectionExpanded={setSuppressSectionExpanded}
            setShowAddSuppress={setShowAddSuppress}
            setEditingSuppress={setEditingSuppress}
            setSuppressForm={setSuppressForm}
            handleSaveSuppressions={handleSaveSuppressions}
          />

          <SuppressAlarmModal
            open={showAddSuppress}
            onClose={() => { setShowAddSuppress(false); }}
            suppressForm={suppressForm}
            setSuppressForm={setSuppressForm}
            editingSuppress={editingSuppress}
            suppressions={suppressions}
            handleSaveSuppressions={handleSaveSuppressions}
            setEditingSuppress={setEditingSuppress}
          />

          {/* 4a-iii. Escalation Contacts (who to call at the customer) */}
          <EscalationContactsCard
            escalationContacts={escalationContacts}
            escalationProcedure={escalationProcedure}
            handleSaveEscalationProcedure={handleSaveEscalationProcedure}
            contactsSectionExpanded={contactsSectionExpanded}
            setContactsSectionExpanded={setContactsSectionExpanded}
            setShowAddContact={setShowAddContact}
            setEditingContact={setEditingContact}
            setContactForm={setContactForm}
            handleSaveEscalationContacts={handleSaveEscalationContacts}
          />

          <EscalationContactModal
            open={showAddContact}
            onClose={() => { setShowAddContact(false); }}
            contactForm={contactForm}
            setContactForm={setContactForm}
            editingContact={editingContact}
            escalationContacts={escalationContacts}
            handleSaveEscalationContacts={handleSaveEscalationContacts}
            setEditingContact={setEditingContact}
          />

          {/* 4b. Escalate Ticket Card (replaces legacy Zendesk macro) */}
          {!selectedAsset && !selectedItPortalAsset && (
            <EscalationCard
              escalationSectionExpanded={escalationSectionExpanded}
              setEscalationSectionExpanded={setEscalationSectionExpanded}
              ticketId={ticketId}
              assigneeOptions={assigneeOptions}
              statusOptions={statusOptions}
              escalationForm={escalationForm}
              setEscalationForm={setEscalationForm}
              isEscalating={isEscalating}
              handleEscalate={handleEscalate}
            />
          )}

          {/* 5. OPS Calendar Card */}
          {!selectedAsset && !selectedItPortalAsset && (
            <div style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #D8DCDE',
              borderRadius: '0',
              marginBottom: '0px',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
            }}>
              <div
                onClick={() => setCalendarSectionExpanded(!calendarSectionExpanded)}
                style={{
                  cursor: "pointer",
                  padding: "10px 12px",
                  minHeight: '35px',
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: calendarSectionExpanded ? '1px solid #D8DCDE' : 'none'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 32, height: 32, borderRadius: 8,
                    backgroundColor: '#EAF2FB', flexShrink: 0
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                      stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
                    OPS Calendar
                  </span>
                  <OnCallBadge />
                </div>
                <span style={{ color: '#68737D', fontSize: '12px' }}>
                  {calendarSectionExpanded ? "▼" : "▶"}
                </span>
              </div>
              
              {calendarSectionExpanded && (
                <div style={{ padding: "12px" }}>
                  <OPSCalendarComponent requester={requester} assets={assets} requesterOrg={requesterOrg} />
                </div>
              )}
            </div>
          )}

          {/* 6. IT Portal Assets Card */}
          <div style={{
            backgroundColor: '#FFFFFF',
            border: '1px solid #D8DCDE',
            borderRadius: '0',
            marginBottom: '0px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
          }}>
            <div
              onClick={() => {
                setItPortalSectionExpanded(!itPortalSectionExpanded);
                if (itPortalSectionExpanded) {
                  setItPortalSearchQuery('');
                }
              }}
              style={{
                cursor: "pointer",
                padding: "10px 12px",
                minHeight: '35px',
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: itPortalSectionExpanded ? '1px solid #D8DCDE' : 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: 8,
                  backgroundColor: '#EAF2FB', flexShrink: 0
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                    stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                    <line x1="6" y1="6" x2="6.01" y2="6" />
                    <line x1="6" y1="18" x2="6.01" y2="18" />
                  </svg>
                </span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
                  IT Portal Assets ({itPortalAssets.length})
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    fetchITPortalAssets();
                  }}
                  disabled={itPortalLoading}
                  style={{
                    background: 'transparent',
                    border: '1px solid #D8DCDE',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    fontSize: '10px',
                    color: '#68737D',
                    cursor: itPortalLoading ? 'not-allowed' : 'pointer',
                    marginLeft: '8px'
                  }}
                >
                  {itPortalLoading ? '↻' : '🔄'} Refresh
                </button>
                {itPortalLastUpdated && (
                  <span style={{ 
                    fontSize: '9px', 
                    color: '#B8B8B8',
                    marginLeft: '8px'
                  }}>
                    {itPortalLastUpdated.toLocaleTimeString()}
                  </span>
                )}
              </div>
              <span style={{ color: '#68737D', fontSize: '12px' }}>
                {itPortalSectionExpanded ? "▼" : "▶"}
              </span>
            </div>
            
            {itPortalSectionExpanded && (
              <div style={{ padding: "12px" }}>
                {selectedItPortalAsset ? (
                  /* IT Portal Asset Detail View */
                  <div>
                    <div style={{ 
                      display: 'flex', 
                      flexDirection: 'column',
                      gap: '12px',
                      marginBottom: '0px',
                      paddingBottom: '12px',
                      borderBottom: '1px solid #D8DCDE'
                    }}>
                      {/* Top Row: Back button and Title */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button 
                          onClick={handleItPortalAssetBack} 
                          style={{
                            background: 'transparent',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            padding: '6px 10px',
                            fontSize: '11px',
                            color: '#68737D',
                            cursor: 'pointer',
                            flexShrink: 0
                          }}
                        >
                          ← Back
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: '16px', flexShrink: 0 }}>
                            {getDeviceIcon(selectedItPortalAsset.device_type)}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
                              IT Portal Device
                            </div>
                            <div style={{ 
                              fontSize: '10px', 
                              color: '#68737D',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}>
                              {selectedItPortalAsset.asset_tag || 'Unnamed Device'}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Bottom Row: Action Buttons */}
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{
                          backgroundColor: editingItPortalAsset ? '#F79A0A' : '#1F73B7',
                          color: 'white',
                          padding: '4px 8px',
                          borderRadius: '12px',
                          fontSize: '9px',
                          fontWeight: '600',
                          textTransform: 'uppercase'
                        }}>
                          {editingItPortalAsset ? 'EDITING' : 'READ ONLY'}
                        </div>
                        
                        {!editingItPortalAsset ? (
                          <button
                            onClick={handleStartEditItPortalAsset}
                            style={{
                              backgroundColor: '#1F73B7',
                              color: 'white',
                              border: 'none',
                              padding: '6px 12px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: '600',
                              cursor: 'pointer'
                            }}
                          >
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={handleSaveItPortalAsset}
                              style={{
                                backgroundColor: '#2E7D0F',
                                color: 'white',
                                border: 'none',
                                padding: '6px 12px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: '600',
                                cursor: 'pointer'
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={handleCancelEditItPortalAsset}
                              style={{
                                backgroundColor: '#CC3340',
                                color: 'white',
                                border: 'none',
                                padding: '6px 12px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: '600',
                                cursor: 'pointer'
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: '1fr 1fr', 
                      gap: '12px',
                      marginBottom: '16px'
                    }}>
                      {/* Type */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Type
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="type" 
                            value={itPortalFormData.type || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.device_type || selectedItPortalAsset.type || 'Unknown'}
                          </div>
                        )}
                      </div>

                      {/* Name */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Name
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="name" 
                            value={itPortalFormData.name || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.name || selectedItPortalAsset.asset_tag || 'Unnamed'}
                          </div>
                        )}
                      </div>

                      {/* Host Name */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Host Name
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="host_name" 
                            value={itPortalFormData.host_name || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.host_name || selectedItPortalAsset.hostname || 'Not specified'}
                          </div>
                        )}
                      </div>

                      {/* Description */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Description
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="description" 
                            value={itPortalFormData.description || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.description || 'No description'}
                          </div>
                        )}
                      </div>

                      {/* Domain/Realm */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Domain/Realm
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="domain" 
                            value={itPortalFormData.domain || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.domain || selectedItPortalAsset.realm || 'Not specified'}
                          </div>
                        )}
                      </div>

                      {/* Facility */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Facility
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="facility" 
                            value={itPortalFormData.facility || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.facility || selectedItPortalAsset.location || 'Not specified'}
                          </div>
                        )}
                      </div>

                      {/* Username */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Username
                        </label>
                        {editingItPortalAsset ? (
                          <input 
                            name="username" 
                            value={itPortalFormData.username || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          />
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.username || selectedItPortalAsset.assigned_user || 'Not specified'}
                          </div>
                        )}
                      </div>

                      {/* Preferred Access */}
                      <div>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Preferred Access
                        </label>
                        {editingItPortalAsset ? (
                          <select 
                            name="preferred_access" 
                            value={itPortalFormData.preferred_access || ""} 
                            onChange={(e) => handleInputChange(e, setItPortalFormData)}
                            style={{
                              width: '100%',
                              padding: '6px 8px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          >
                            <option value="">-- Select Access Method --</option>
                            <option value="RDP">RDP</option>
                            <option value="SSH">SSH</option>
                            <option value="VNC">VNC</option>
                            <option value="TeamViewer">TeamViewer</option>
                            <option value="HTTP">HTTP</option>
                            <option value="HTTPS">HTTPS</option>
                            <option value="Telnet">Telnet</option>
                            <option value="Console">Console</option>
                            <option value="Other">Other</option>
                          </select>
                        ) : (
                          <div style={{
                            padding: '6px 8px',
                            fontSize: '12px',
                            border: '1px solid #D8DCDE',
                            borderRadius: '4px',
                            backgroundColor: '#F8F9FA',
                            color: '#2F3941',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            overflow: 'hidden',
                            minWidth: 0
                          }}>
                            {selectedItPortalAsset.preferred_access || selectedItPortalAsset.access_method || 'Not specified'}
                          </div>
                        )}
                      </div>

                      {/* Credentials - Security Note */}
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={{
                          display: 'block',
                          fontSize: '11px',
                          fontWeight: '600',
                          color: '#68737D',
                          marginBottom: '4px'
                        }}>
                          Credentials
                        </label>
                        <div style={{
                          padding: '8px',
                          fontSize: '12px',
                          border: '1px solid #D8DCDE',
                          borderRadius: '4px',
                          backgroundColor: '#FFF4CC',
                          color: '#B54708',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}>
                          <span style={{ fontWeight: '600' }}>🔒</span>
                          Credential information is not displayed for security reasons
                        </div>
                      </div>

                      {/* Additional System Info */}
                      <div style={{ gridColumn: '1 / -1', marginTop: '8px', paddingTop: '12px', borderTop: '1px solid #D8DCDE' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', fontSize: '11px' }}>
                          <div>
                            <span style={{ fontWeight: '600', color: '#68737D' }}>Company:</span>
                            <div style={{ color: '#2F3941', marginTop: '2px' }}>
                              {selectedItPortalAsset.company_name || 'Unknown'}
                            </div>
                          </div>
                          <div>
                            <span style={{ fontWeight: '600', color: '#68737D' }}>Status:</span>
                            <div style={{ color: '#2F3941', marginTop: '2px', textTransform: 'capitalize' }}>
                              {selectedItPortalAsset.status || 'Active'}
                            </div>
                          </div>
                          <div>
                            <span style={{ fontWeight: '600', color: '#68737D' }}>Last Updated:</span>
                            <div style={{ color: '#2F3941', marginTop: '2px' }}>
                              {selectedItPortalAsset.imported_date ? 
                                new Date(selectedItPortalAsset.imported_date).toLocaleDateString() : 
                                'Unknown'
                              }
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Footer */}
                    <div style={{
                      backgroundColor: editingItPortalAsset ? '#FFF4CC' : '#E8F5E8',
                      border: editingItPortalAsset ? '1px solid #F79A0A' : '1px solid #4CAF50',
                      borderRadius: '4px',
                      padding: '8px 12px',
                      fontSize: '11px',
                      color: editingItPortalAsset ? '#B54708' : '#2E7D0F',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}>
                      <span>
                        <strong>{editingItPortalAsset ? 'Editing Mode:' : 'IT Portal Device:'}</strong> {
                          editingItPortalAsset 
                            ? 'Changes will be saved to your IT Portal system.' 
                            : 'This device is managed in your IT Portal system. Click Edit to modify.'
                        }
                      </span>
                      <span style={{
                        backgroundColor: editingItPortalAsset ? '#B54708' : '#2E7D0F',
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '9px',
                        fontWeight: '600'
                      }}>
                        ID: {selectedItPortalAsset.id}
                      </span>
                    </div>
                  </div>
                ) : (
                  
                  /* IT Portal Assets List */
                  <div>
                    {itPortalError && (
                      <div style={{
                        backgroundColor: '#FBEAEA',
                        border: '1px solid #CC3340',
                        borderRadius: '4px',
                        padding: '8px 12px',
                        marginBottom: '12px',
                        fontSize: '11px',
                        color: '#CC3340'
                      }}>
                        <strong>Error loading IT Portal assets:</strong> {itPortalError}
                        <button
                          onClick={fetchITPortalAssets}
                          style={{
                            marginLeft: '8px',
                            background: 'transparent',
                            border: 'none',
                            color: '#CC3340',
                            textDecoration: 'underline',
                            cursor: 'pointer',
                            fontSize: '11px'
                          }}
                        >
                          Try again
                        </button>
                      </div>
                    )}

                    {itPortalLoading && (
                      <div style={{
                        textAlign: 'center',
                        padding: '20px',
                        color: '#68737D',
                        fontSize: '12px'
                      }}>
                        Loading IT Portal assets...
                      </div>
                    )}

                    {!requesterOrg && !itPortalLoading && (
                      <div style={{
                        padding: "20px",
                        textAlign: "center",
                        color: "#68737D",
                        fontSize: "12px"
                      }}>
                        IT Portal assets require an organization association.
                      </div>
                    )}

                    {!itPortalLoading && !itPortalError && requesterOrg && itPortalAssets.length === 0 && (
                      <div style={{
                        padding: "20px",
                        textAlign: "center",
                        color: "#68737D",
                        fontSize: "12px"
                      }}>
                        No IT Portal assets found for {requesterOrg.name}.
                        <div style={{
                          fontSize: "11px",
                          color: "#B8B8B8",
                          marginTop: "4px"
                        }}>
                          These are devices managed in your IT Portal system
                        </div>
                      </div>
                    )}

                    {itPortalAssets.length > 0 && !itPortalLoading && (
                      <div>
                        {/* Search Bar */}
                        <div style={{ marginBottom: '12px' }}>
                          <input
                            type="text"
                            placeholder="Search devices by name, hostname, type, location..."
                            value={itPortalSearchQuery}
                            onChange={(e) => setItPortalSearchQuery(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '8px 12px',
                              fontSize: '12px',
                              border: '1px solid #D8DCDE',
                              borderRadius: '4px',
                              backgroundColor: '#FFFFFF',
                              boxSizing: 'border-box'
                            }}
                          />
                          {itPortalSearchQuery && (
                            <div style={{
                              marginTop: '4px',
                              fontSize: '11px',
                              color: '#68737D'
                            }}>
                              Found {filteredItPortalAssets.length} of {itPortalAssets.length} devices
                            </div>
                          )}
                        </div>
                        
                        <div style={{
                          fontSize: '11px',
                          color: '#68737D',
                          marginBottom: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between'
                        }}>
                          <span>Live data from IT Portal system</span>
                          <span style={{
                            backgroundColor: '#E8F5E8',
                            color: '#2E7D0F',
                            padding: '2px 6px',
                            borderRadius: '12px',
                            fontSize: '9px',
                            fontWeight: '600'
                          }}>
                            LIVE DATA
                          </span>
                        </div>

                        {itPortalSearchQuery && filteredItPortalAssets.length === 0 && (
                          <div style={{
                            padding: '20px',
                            textAlign: 'center',
                            color: '#68737D',
                            fontSize: '12px',
                            backgroundColor: '#F8F9FA',
                            borderRadius: '6px',
                            border: '1px dashed #D8DCDE'
                          }}>
                            No devices found matching "{itPortalSearchQuery}"
                          </div>
                        )}

                        {(() => {
                          const assetsByCompany = filteredItPortalAssets.reduce((groups, asset) => {
                            const companyName = asset.company_name || 'Unknown Company';
                            if (!groups[companyName]) {
                              groups[companyName] = [];
                            }
                            groups[companyName].push(asset);
                            return groups;
                          }, {});
                          
                          // Order groups: any company/location that contains a
                          // ticket-matched asset floats to the top, then alphabetical.
                          const groupHasMatch = (name) =>
                            ticketText && assetsByCompany[name].some(a => assetMatchesTicket(a));
                          const companyNames = Object.keys(assetsByCompany).sort((a, b) => {
                            const am = groupHasMatch(a) ? 1 : 0;
                            const bm = groupHasMatch(b) ? 1 : 0;
                            if (am !== bm) return bm - am;          // matched groups first
                            return a.localeCompare(b);              // then alphabetical
                          });
                          
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                              {isBILH && isMultiCompany && !itPortalSearchQuery && (
                                <div style={{
                                  backgroundColor: '#1F73B7',
                                  color: 'white',
                                  borderRadius: '6px',
                                  padding: '10px 14px',
                                  marginBottom: '8px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '16px' }}>🏥</span>
                                    <div>
                                      <div style={{ fontSize: '13px', fontWeight: '600' }}>
                                        Beth Israel Lahey Health Network
                                      </div>
                                      <div style={{ fontSize: '11px', opacity: 0.9 }}>
                                        {companyNames.length} Hospitals • {itPortalAssets.length} Total Devices
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                              
                              {companyNames.map(companyName => {
                                const displayName = isBILH 
                                  ? companyName.replace(/^BILH[-\s]+/i, '') 
                                  : companyName;
                                
                                const isExpanded = itPortalSearchQuery
                                  ? true
                                  : (expandedHospitals[companyName] !== false);

                                return (
                                  <div key={companyName}>
                                    {isMultiCompany && (
                                      <div 
                                        onClick={() => {
                                          if (!itPortalSearchQuery) {
                                            setExpandedHospitals(prev => ({
                                              ...prev,
                                              [companyName]: !prev[companyName]
                                            }));
                                          }
                                        }}
                                        style={{
                                          backgroundColor: isBILH ? '#F0F7FF' : '#F8F9FA',
                                          border: `1px solid ${isBILH ? '#1F73B7' : '#D8DCDE'}`,
                                          borderRadius: !isExpanded ? '4px' : '4px 4px 0 0',
                                          padding: '8px 12px',
                                          fontSize: '12px',
                                          fontWeight: '600',
                                          color: '#2F3941',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          cursor: itPortalSearchQuery ? 'default' : 'pointer',
                                          userSelect: 'none'
                                        }}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                          <span style={{ fontSize: '10px', color: '#68737D' }}>
                                            {isExpanded ? '▼' : '▶'}
                                          </span>
                                          {isBILH && <span style={{ fontSize: '14px' }}>🏥</span>}
                                          <span>{displayName}</span>
                                        </div>
                                        <span style={{
                                          backgroundColor: isBILH ? '#1F73B7' : '#68737D',
                                          color: 'white',
                                          padding: '2px 8px',
                                          borderRadius: '10px',
                                          fontSize: '10px',
                                          fontWeight: '500'
                                        }}>
                                          {assetsByCompany[companyName].length} devices
                                        </span>
                                      </div>
                                    )}
                                    
                                    {isExpanded && (
                                      <div style={{ 
                                        display: 'flex', 
                                        flexDirection: 'column', 
                                        gap: '8px',
                                        ...(isMultiCompany ? {
                                          borderLeft: `1px solid ${isBILH ? '#1F73B7' : '#D8DCDE'}`,
                                          borderRight: `1px solid ${isBILH ? '#1F73B7' : '#D8DCDE'}`,
                                          borderBottom: `1px solid ${isBILH ? '#1F73B7' : '#D8DCDE'}`,
                                          borderRadius: '0 0 4px 4px',
                                          padding: '8px',
                                          backgroundColor: '#FAFBFC'
                                        } : {})
                                      }}>
                                        {assetsByCompany[companyName].slice().sort((a, b) => {
                                          // Surface ticket-matching assets first.
                                          if (!ticketText) return 0;
                                          return (assetMatchesTicket(b) ? 1 : 0) - (assetMatchesTicket(a) ? 1 : 0);
                                        }).map((asset, index) => {
                                          const assetTag = asset.asset_tag || `Device-${index + 1}`;
                                          const status = asset.status || 'Active';

                                          // Highlight only on an exact full-FQDN match against the ticket.
                                          const isTicketMatch = assetMatchesTicket(asset);
                                          const assetFqdn = getAssetFqdn(asset);

                                          return (
                                            <div
                                              key={`${companyName}-${asset.id || index}`}
                                              onClick={() => {
                                                setSelectedItPortalAsset(asset);
                                              }}
                                              title={assetFqdn ? `${assetFqdn} — use the buttons to connect` : 'View details'}
                                              style={{
                                                cursor: "pointer",
                                                padding: "10px",
                                                borderRadius: "6px",
                                                border: isTicketMatch ? "2px solid #D4860B" : "1px solid #D8DCDE",
                                                backgroundColor: isTicketMatch ? "#FFF8EC" : "#FFFFFF",
                                                transition: "all 0.2s ease",
                                                fontSize: "12px",
                                                userSelect: "none",
                                                boxShadow: isTicketMatch ? "0 0 0 1px #F2C26B inset" : "none"
                                              }}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.backgroundColor = "#E8F5E8";
                                                e.currentTarget.style.borderColor = "#1F73B7";
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.backgroundColor = isTicketMatch ? "#FFF8EC" : "#FFFFFF";
                                                e.currentTarget.style.borderColor = isTicketMatch ? "#D4860B" : "#D8DCDE";
                                              }}
                                            >
                                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                                <span style={{ fontSize: '14px' }}>
                                                  {getDeviceIcon(asset.device_type)}
                                                </span>
                                                <span style={{ 
                                                  fontWeight: "600", 
                                                  color: "#2F3941",
                                                  fontFamily: "monospace",
                                                  fontSize: "11px",
                                                  wordBreak: "break-word"
                                                }}>
                                                  {assetTag}
                                                </span>
                                                {isTicketMatch && (
                                                  <span style={{
                                                    marginLeft: 'auto',
                                                    fontSize: '9px',
                                                    fontWeight: 700,
                                                    color: '#8A5800',
                                                    backgroundColor: '#FCE5B8',
                                                    padding: '2px 6px',
                                                    borderRadius: '3px',
                                                    border: '1px solid #D4860B',
                                                    whiteSpace: 'nowrap',
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.3px'
                                                  }}>
                                                    ★ On this ticket
                                                  </span>
                                                )}
                                              </div>
                                              
                                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '22px' }}>
                                                {isMultiCompany && isBILH && (
                                                  <div style={{ 
                                                    fontSize: "9px",
                                                    fontWeight: "600",
                                                    color: '#1F73B7',
                                                    backgroundColor: '#E8F5FF',
                                                    padding: "2px 6px",
                                                    borderRadius: "3px",
                                                    border: '1px solid #1F73B7'
                                                  }}>
                                                    {displayName}
                                                  </div>
                                                )}
                                                <div style={{ 
                                                  fontSize: "10px",
                                                  fontWeight: "600",
                                                  color: '#1F73B7',
                                                  backgroundColor: '#E8F5E8',
                                                  padding: "2px 6px",
                                                  borderRadius: "12px",
                                                  textTransform: "uppercase"
                                                }}>
                                                  {status}
                                                </div>
                                              </div>

                                              <div style={{ display: 'flex', gap: '6px', marginTop: '8px', paddingLeft: '22px' }}>
                                                <button
                                                  type="button"
                                                  onClick={(e) => { e.stopPropagation(); connectToAsset(asset); }}
                                                  disabled={!assetFqdn}
                                                  title={assetFqdn ? `SSH to ${assetFqdn} via tools server` : 'No FQDN available'}
                                                  style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                    padding: '3px 8px', fontSize: '11px', fontWeight: 600,
                                                    color: '#FFFFFF', border: 'none', borderRadius: '4px',
                                                    backgroundColor: assetFqdn ? '#1F73B7' : '#A9C5E4',
                                                    cursor: assetFqdn ? 'pointer' : 'not-allowed'
                                                  }}
                                                >
                                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="4 17 10 11 4 5" />
                                                    <line x1="12" y1="19" x2="20" y2="19" />
                                                  </svg>
                                                  SSH
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={(e) => { e.stopPropagation(); openAssetHttp(asset); }}
                                                  disabled={!assetFqdn}
                                                  title={assetFqdn ? `Open https://${assetFqdn}` : 'No FQDN available'}
                                                  style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                    padding: '3px 8px', fontSize: '11px', fontWeight: 600,
                                                    color: assetFqdn ? '#1F73B7' : '#A9B4BD',
                                                    border: `1px solid ${assetFqdn ? '#1F73B7' : '#D8DCDE'}`,
                                                    borderRadius: '4px', backgroundColor: '#FFFFFF',
                                                    cursor: assetFqdn ? 'pointer' : 'not-allowed'
                                                  }}
                                                >
                                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <line x1="2" y1="12" x2="22" y2="12" />
                                                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                                                  </svg>
                                                  HTTP
                                                </button>
                                                <button
                                                  type="button"
                                                  onClick={(e) => { e.stopPropagation(); setSelectedItPortalAsset(asset); }}
                                                  title="View asset details"
                                                  style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                    padding: '3px 8px', fontSize: '11px', fontWeight: 600,
                                                    color: '#68737D', border: '1px solid #D8DCDE', borderRadius: '4px',
                                                    backgroundColor: '#FFFFFF', cursor: 'pointer'
                                                  }}
                                                >
                                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <line x1="12" y1="16" x2="12" y2="12" />
                                                    <line x1="12" y1="8" x2="12.01" y2="8" />
                                                  </svg>
                                                  Details
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                        
                        <div style={{
                          backgroundColor: '#E8F5E8',
                          border: '1px solid #4CAF50',
                          borderRadius: '4px',
                          padding: '8px 12px',
                          marginTop: '12px',
                          fontSize: '11px',
                          color: '#2E7D0F'
                        }}>
                          <strong>Editable IT Portal Assets:</strong> These devices are managed in your IT Portal system
                          {isMultiCompany && isBILH && ' across multiple hospital locations'}. 
                          Click any asset to view details, then click Edit to modify fields.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 7. Zendesk Assets Card */}
          <div style={{
            backgroundColor: '#FFFFFF',
            border: '1px solid #D8DCDE',
            borderRadius: '0',
            marginBottom: '0px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
          }}>
            <div
              onClick={() => setAssetsSectionExpanded(!assetsSectionExpanded)}
              style={{
                cursor: "pointer",
                padding: "10px 12px",
                minHeight: '35px',
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: assetsSectionExpanded ? '1px solid #D8DCDE' : 'none'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 32, height: 32, borderRadius: 8,
                  backgroundColor: '#EAF2FB', flexShrink: 0
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                    stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                    <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                    <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
                  </svg>
                </span>
                <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
                  Zendesk Assets ({assets.length})
                </span>
              </div>
              <span style={{ color: '#68737D', fontSize: '12px' }}>
                {assetsSectionExpanded ? "▼" : "▶"}
              </span>
            </div>
            
            {assetsSectionExpanded && (
              <div style={{ padding: "12px" }}>
                {assets.length === 0 ? (
                  <div style={{
                    padding: "20px",
                    textAlign: "center",
                    color: "#68737D",
                    fontSize: "12px"
                  }}>
                    No assets found for this user.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {assets.map((a, index) => {
                      const assetTag = a.name || "No Tag";
                      const description = a.custom_object_fields?.asset_name || "Unnamed Asset";
                      const status = a.custom_object_fields?.status || "Unknown";
                      
                      return (
                        <div
                          key={a.id || a.name}
                          onClick={() => handleAssetClick(a)}
                          style={{
                            cursor: "pointer",
                            padding: "12px",
                            borderRadius: "6px",
                            border: "1px solid #D8DCDE",
                            backgroundColor: "#F8F9FA",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            transition: "all 0.2s ease",
                            fontSize: "12px"
                          }}
                          onMouseEnter={(e) => {
                            e.target.style.backgroundColor = "#F0F4F8";
                            e.target.style.borderColor = "#1F73B7";
                          }}
                          onMouseLeave={(e) => {
                            e.target.style.backgroundColor = "#F8F9FA";
                            e.target.style.borderColor = "#D8DCDE";
                          }}
                        >
                          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ 
                              fontWeight: "600", 
                              color: "#2F3941",
                              fontFamily: "monospace",
                              fontSize: "11px",
                              flex: 1,
                              minWidth: 0,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: "200px"
                            }}>
                              {assetTag}
                            </span>
                            <span style={{ color: "#68737D", fontSize: "11px" }}>-</span>
                            <span style={{ 
                              color: "#68737D",
                              flex: 1,
                              fontSize: "11px"
                            }}>
                              {description}
                            </span>
                          </div>
                          <div style={{ 
                            fontSize: "10px",
                            fontWeight: "600",
                            color: status.toLowerCase() === 'active' ? '#2E7D0F' : 
                                   status.toLowerCase() === 'retired' ? '#CC3340' : '#B54708',
                            backgroundColor: status.toLowerCase() === 'active' ? '#E8F5E8' : 
                                           status.toLowerCase() === 'retired' ? '#FBEAEA' : '#FFF4CC',
                            padding: "2px 6px",
                            borderRadius: "12px",
                            textTransform: "uppercase"
                          }}>
                            {status}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 8. Create New Asset Card */}
          {!selectedAsset && !selectedItPortalAsset && (
            <div style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #D8DCDE',
              borderRadius: '0',
              marginBottom: '0px',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
            }}>
              <div
                onClick={() => setCreateAssetExpanded(!createAssetExpanded)}
                style={{
                  cursor: "pointer",
                  padding: "10px 12px",
                  minHeight: '35px',
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: createAssetExpanded ? '1px solid #D8DCDE' : 'none'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 32, height: 32, borderRadius: 8,
                    backgroundColor: '#EAF2FB', flexShrink: 0
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                      stroke="#1F5FA8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="12" y1="8" x2="12" y2="16" />
                      <line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: '600', color: '#2F3941' }}>
                    Create New Zendesk Asset
                  </span>
                </div>
                <span style={{ color: '#68737D', fontSize: '12px' }}>
                  {createAssetExpanded ? "▼" : "▶"}
                </span>
              </div>
              
              {createAssetExpanded && (
                <div style={{ padding: "12px" }}>
                  <div style={{ 
                    display: 'grid', 
                    gridTemplateColumns: '1fr 1fr', 
                    gap: '12px',
                    marginBottom: '16px'
                  }}>
                    {/* Asset Name */}
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={{
                        display: 'block',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#68737D',
                        marginBottom: '4px'
                      }}>
                        Asset Name *
                      </label>
                      <input 
                        name="asset_name" 
                        value={newAssetForm.asset_name || ""} 
                        onChange={(e) => handleInputChange(e, setNewAssetForm)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          fontSize: '12px',
                          border: formErrors.asset_name ? '1px solid #CC3340' : '1px solid #D8DCDE',
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                        placeholder="Enter asset name"
                      />
                      {formErrors.asset_name && (
                        <span style={{ fontSize: '10px', color: '#CC3340' }}>{formErrors.asset_name}</span>
                      )}
                    </div>

                    {/* Manufacturer */}
                    <div>
                      <label style={{
                        display: 'block',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#68737D',
                        marginBottom: '4px'
                      }}>
                        Manufacturer *
                      </label>
                      <input 
                        name="manufacturer" 
                        value={newAssetForm.manufacturer || ""} 
                        onChange={(e) => handleInputChange(e, setNewAssetForm)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          fontSize: '12px',
                          border: formErrors.manufacturer ? '1px solid #CC3340' : '1px solid #D8DCDE',
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                        placeholder="e.g., Dell, HP, Apple"
                      />
                      {formErrors.manufacturer && (
                        <span style={{ fontSize: '10px', color: '#CC3340' }}>{formErrors.manufacturer}</span>
                      )}
                    </div>

                    {/* Model Number */}
                    <div>
                      <label style={{
                        display: 'block',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#68737D',
                        marginBottom: '4px'
                      }}>
                        Model Number *
                      </label>
                      <input 
                        name="model_number" 
                        value={newAssetForm.model_number || ""} 
                        onChange={(e) => handleInputChange(e, setNewAssetForm)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          fontSize: '12px',
                          border: formErrors.model_number ? '1px solid #CC3340' : '1px solid #D8DCDE',
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                        placeholder="Model number"
                      />
                      {formErrors.model_number && (
                        <span style={{ fontSize: '10px', color: '#CC3340' }}>{formErrors.model_number}</span>
                      )}
                    </div>

                    {/* Serial Number */}
                    <div>
                      <label style={{
                        display: 'block',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#68737D',
                        marginBottom: '4px'
                      }}>
                        Serial Number
                      </label>
                      <input 
                        name="serial_number" 
                        value={newAssetForm.serial_number || ""} 
                        onChange={(e) => handleInputChange(e, setNewAssetForm)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          fontSize: '12px',
                          border: '1px solid #D8DCDE',
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                        placeholder="Serial number (optional)"
                      />
                    </div>

                    {/* Status */}
                    <div>
                      <label style={{
                        display: 'block',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#68737D',
                        marginBottom: '4px'
                      }}>
                        Status
                      </label>
                      <select 
                        name="status" 
                        value={newAssetForm.status || "active"} 
                        onChange={(e) => handleInputChange(e, setNewAssetForm)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          fontSize: '12px',
                          border: '1px solid #D8DCDE',
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                        <option value="retired">Retired</option>
                        <option value="in_repair">In Repair</option>
                      </select>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div style={{ 
                    display: 'flex', 
                    gap: '8px',
                    paddingTop: '12px',
                    borderTop: '1px solid #D8DCDE'
                  }}>
                    <button
                      onClick={handleCreateNewAsset}
                      style={{
                        flex: 1,
                        padding: '8px 12px',
                        fontSize: '12px',
                        fontWeight: '600',
                        backgroundColor: '#1F73B7',
                        color: '#FFFFFF',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Create Asset
                    </button>
                    <button
                      onClick={() => {
                        setNewAssetForm({});
                        setFormErrors({});
                        setCreateAssetExpanded(false);
                      }}
                      style={{
                        padding: '8px 12px',
                        fontSize: '12px',
                        backgroundColor: '#FFFFFF',
                        color: '#68737D',
                        border: '1px solid #D8DCDE',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Asset Edit Modal */}
      {selectedAsset && (
        <div style={{
          backgroundColor: '#FFFFFF',
          border: '1px solid #D8DCDE',
          borderRadius: '0',
          padding: '16px',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
        }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            marginBottom: '0px',
            paddingBottom: '12px',
            borderBottom: '1px solid #D8DCDE'
          }}>
            <button 
              onClick={handleBack} 
              style={{
                background: 'transparent',
                border: '1px solid #D8DCDE',
                borderRadius: '4px',
                padding: '6px 10px',
                fontSize: '11px',
                color: '#68737D',
                cursor: 'pointer',
                marginRight: '12px'
              }}
            >
              ← Back
            </button>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '600', color: '#2F3941' }}>
                Edit Asset Details
              </div>
              <div style={{ fontSize: '11px', color: '#68737D' }}>
                Asset Tag: {selectedAsset.name || "No Tag"}
              </div>
            </div>
          </div>

          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '1fr 1fr', 
            gap: '12px',
            marginBottom: '16px'
          }}>
            {/* Asset Name */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Asset Name
              </label>
              <input 
                name="asset_name" 
                value={formData.asset_name || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Manufacturer */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Manufacturer
              </label>
              <input 
                name="manufacturer" 
                value={formData.manufacturer || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Model Number */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Model Number
              </label>
              <input 
                name="model_number" 
                value={formData.model_number || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Serial Number */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Serial Number
              </label>
              <input 
                name="serial_number" 
                value={formData.serial_number || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Status */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Status
              </label>
              <select 
                name="status" 
                value={formData.status || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="">-- Select Status --</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="retired">Retired</option>
              </select>
            </div>

            {/* Purchase Date */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Purchase Date
              </label>
              <input 
                type="date"
                name="purchase_date" 
                value={formData.purchase_date || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Warranty Expiration */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Warranty Expiration
              </label>
              <input 
                type="date"
                name="warranty_expiration" 
                value={formData.warranty_expiration || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {/* Assigned To User */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Assigned to User
              </label>
              <select 
                name="assigned_to_user" 
                value={formData.assigned_to_user || ""} 
                onChange={(e) => {
                  handleInputChange(e, setFormData);
                  // Clear org assignment when user is selected
                  if (e.target.value) {
                    setFormData(prev => ({ ...prev, assigned_to_org: '' }));
                  }
                }}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="">-- Unassigned --</option>
                {users.map(user => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Assigned To Organization */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Assigned to Organization
              </label>
              <select 
                name="assigned_to_org" 
                value={formData.assigned_to_org || ""} 
                onChange={(e) => {
                  handleInputChange(e, setFormData);
                  // Clear user assignment when org is selected
                  if (e.target.value) {
                    setFormData(prev => ({ ...prev, assigned_to_user: '' }));
                  }
                }}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="">-- Unassigned --</option>
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Approved By */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: '600',
                color: '#68737D',
                marginBottom: '4px'
              }}>
                Approved By
              </label>
              <select 
                name="approved_by" 
                value={formData.approved_by || ""} 
                onChange={(e) => handleInputChange(e, setFormData)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="">-- Not Set --</option>
                {users.map(user => (
                  <option key={user.id} value={user.name}>
                    {user.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ 
            display: 'flex', 
            gap: '8px',
            paddingTop: '12px',
            borderTop: '1px solid #D8DCDE'
          }}>
            <button 
              onClick={handleSave}
              style={{
                backgroundColor: '#1F73B7',
                color: '#FFFFFF',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: '500',
                cursor: 'pointer',
                flex: 1
              }}
            >
              Save Changes
            </button>
            <button 
              onClick={handleDeleteAsset}
              style={{
                backgroundColor: '#CC3340',
                color: '#FFFFFF',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: '500',
                cursor: 'pointer'
              }}
            >
              Delete
            </button>
            <button 
              onClick={handleBack}
              style={{
                backgroundColor: 'transparent',
                color: '#68737D',
                border: '1px solid #D8DCDE',
                padding: '8px 16px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: '500',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div style={{
          position: "fixed",
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
          backgroundColor: "rgba(0, 0, 0, 0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: "2000"
        }}>
          <div style={{
            backgroundColor: "#FFFFFF",
            borderRadius: "8px",
            padding: "24px",
            width: "90%",
            maxWidth: "400px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
            border: "2px solid #CC3340"
          }}>
            <div style={{
              fontSize: "16px",
              fontWeight: "600",
              color: "#CC3340",
              marginBottom: "12px",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}>
              <span style={{ fontSize: "20px" }}>⚠️</span>
              Delete Asset?
            </div>
            
            <div style={{
              fontSize: "13px",
              color: "#2F3941",
              lineHeight: "1.4",
              marginBottom: "16px"
            }}>
              <div style={{ marginBottom: "8px" }}>
                <strong>Asset:</strong> {selectedAsset?.name || 'Unknown'}
              </div>
              <div style={{ marginBottom: "8px" }}>
                <strong>Name:</strong> {selectedAsset?.custom_object_fields?.asset_name || 'Unknown'}
              </div>
              <div style={{
                color: "#CC3340",
                fontWeight: "500",
                fontSize: "12px"
              }}>
                This action cannot be undone.
              </div>
            </div>

            <div style={{
              display: "flex",
              gap: "8px",
              justifyContent: "flex-end"
            }}>
              <button
                onClick={cancelDelete}
                style={{
                  backgroundColor: "transparent",
                  border: "1px solid #D8DCDE",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "12px",
                  color: "#68737D",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  backgroundColor: "#CC3340",
                  border: "1px solid #CC3340",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "12px",
                  color: "#FFFFFF",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Delete Asset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Asset Confirmation Modal */}
      {showCreateConfirm && assetToCreate && (
        <div style={{
          position: "fixed",
          top: "0",
          left: "0",
          right: "0",
          bottom: "0",
          backgroundColor: "rgba(0, 0, 0, 0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: "2000"
        }}>
          <div style={{
            backgroundColor: "#FFFFFF",
            borderRadius: "8px",
            padding: "20px",
            width: "90%",
            maxWidth: "500px",
            maxHeight: "80vh",
            overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
            border: "1px solid #D8DCDE"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "16px",
              paddingBottom: "12px",
              borderBottom: "1px solid #D8DCDE"
            }}>

            <div style={{
                width: "32px",
                height: "32px",
                backgroundColor: "#E8F5E8",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginRight: "12px"
              }}>
                <span style={{ color: "#2E7D0F", fontSize: "16px" }}>+</span>
              </div>
              <div>
                <div style={{
                  fontSize: "16px",
                  fontWeight: "600",
                  color: "#2F3941"
                }}>
                  Confirm Asset Creation
                </div>
                <div style={{
                  fontSize: "12px",
                  color: "#68737D"
                }}>
                  Please review the asset details before creating
                </div>
              </div>
            </div>
            
            <div style={{
              backgroundColor: "#F8F9FA",
              borderRadius: "6px",
              padding: "10px 12px",
              minHeight: '44px',
              marginBottom: "16px",
              border: "1px solid #D8DCDE"
            }}>
              <div style={{
                fontSize: "13px",
                fontWeight: "600",
                color: "#2F3941",
                marginBottom: "12px"
              }}>
                Asset Details:
              </div>
              
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
                <div>
                  <span style={{ fontWeight: "600", color: "#68737D" }}>Name:</span>
                  <div style={{ color: "#2F3941", marginTop: "2px" }}>
                    {assetToCreate.custom_object_fields.asset_name}
                  </div>
                </div>
                
                <div>
                  <span style={{ fontWeight: "600", color: "#68737D" }}>Status:</span>
                  <div style={{ 
                    color: "#2F3941", 
                    marginTop: "2px",
                    textTransform: "capitalize" 
                  }}>
                    {assetToCreate.custom_object_fields.status}
                  </div>
                </div>
                
                <div>
                  <span style={{ fontWeight: "600", color: "#68737D" }}>Manufacturer:</span>
                  <div style={{ color: "#2F3941", marginTop: "2px" }}>
                    {assetToCreate.custom_object_fields.manufacturer}
                  </div>
                </div>
                
                <div>
                  <span style={{ fontWeight: "600", color: "#68737D" }}>Model:</span>
                  <div style={{ color: "#2F3941", marginTop: "2px" }}>
                    {assetToCreate.custom_object_fields.model_number}
                  </div>
                </div>

                {assetToCreate.custom_object_fields.serial_number && (
                  <div>
                    <span style={{ fontWeight: "600", color: "#68737D" }}>Serial:</span>
                    <div style={{ color: "#2F3941", marginTop: "2px" }}>
                      {assetToCreate.custom_object_fields.serial_number}
                    </div>
                  </div>
                )}

                {assetToCreate.custom_object_fields.purchase_date && (
                  <div>
                    <span style={{ fontWeight: "600", color: "#68737D" }}>Purchase Date:</span>
                    <div style={{ color: "#2F3941", marginTop: "2px" }}>
                      {new Date(assetToCreate.custom_object_fields.purchase_date).toLocaleDateString()}
                    </div>
                  </div>
                )}

                {assetToCreate.custom_object_fields.warranty_expiration && (
                  <div>
                    <span style={{ fontWeight: "600", color: "#68737D" }}>Warranty:</span>
                    <div style={{ color: "#2F3941", marginTop: "2px" }}>
                      {new Date(assetToCreate.custom_object_fields.warranty_expiration).toLocaleDateString()}
                    </div>
                  </div>
                )}

                {assetToCreate.custom_object_fields.approved_by && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span style={{ fontWeight: "600", color: "#68737D" }}>Approved By:</span>
                    <div style={{ color: "#2F3941", marginTop: "2px" }}>
                      {assetToCreate.custom_object_fields.approved_by}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{
              display: "flex",
              gap: "8px",
              justifyContent: "flex-end"
            }}>
              <button
                onClick={cancelCreateAsset}
                style={{
                  backgroundColor: "transparent",
                  border: "1px solid #D8DCDE",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "12px",
                  color: "#68737D",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmCreateAsset}
                style={{
                  backgroundColor: "#1F73B7",
                  border: "1px solid #1F73B7",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "12px",
                  color: "#FFFFFF",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Create Asset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);