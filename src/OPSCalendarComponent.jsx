// OPSCalendarComponent.jsx
import React, { useState, useEffect } from 'react';
import { proxyFetch } from './proxyClient';

const BACKEND_BASE_URL = "https://intlxassetmgr-proxy.onrender.com";

function OPSCalendarComponent({ requester, assets }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('upcoming'); // upcoming, week, month
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedDays, setExpandedDays] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  
  // Form state for new events
  const [newEvent, setNewEvent] = useState({
    summary: '',
    description: '',
    location: '',
    startDateTime: '',
    endDateTime: '',
    eventType: 'meeting',
    attendees: [],
    ticketId: '',
    assetIds: []
  });

  // Load events on component mount
  useEffect(() => {
    fetchEvents();
  }, [view]);

  const fetchEvents = async () => {
    setLoading(true);
    setError(null);
    
    try {
      let endpoint = '/api/ops-calendar/upcoming?days=7';
      
      if (view === 'month') {
        endpoint = '/api/ops-calendar/upcoming?days=30';
      } else if (view === 'week') {
        endpoint = '/api/ops-calendar/upcoming?days=7';
      }
      
      const response = await proxyFetch(`${BACKEND_BASE_URL}${endpoint}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.status}`);
      }
      
      const data = await response.json();
      setEvents(data.eventsByDay || {});
      
    } catch (err) {
      console.error('[OPS Calendar] Error fetching events:', err);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchEvents();
  };

  const handleCreateEvent = async () => {
    try {
      // Prepare event data
      const eventData = {
        ...newEvent,
        attendees: newEvent.attendees.filter(email => email.trim())
      };
      
      // Link to current ticket if in Zendesk context
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        const ticketData = await client.get('ticket.id');
        if (ticketData['ticket.id']) {
          eventData.ticketId = ticketData['ticket.id'];
        }
      }
      
      const response = await proxyFetch(`${BACKEND_BASE_URL}/api/ops-calendar/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventData)
      });
      
      if (!response.ok) {
        throw new Error('Failed to create event');
      }
      
      // Reset form and refresh
      setNewEvent({
        summary: '',
        description: '',
        location: '',
        startDateTime: '',
        endDateTime: '',
        eventType: 'meeting',
        attendees: [],
        ticketId: '',
        assetIds: []
      });
      setShowCreateForm(false);
      fetchEvents();
      
      // Show success notification
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'Event created successfully!', 'notice');
      }
      
    } catch (err) {
      console.error('[OPS Calendar] Error creating event:', err);
      setError('Failed to create event');
    }
  };

  const handleDeleteEvent = async (eventId) => {
    if (!confirm('Are you sure you want to delete this event?')) return;
    
    try {
      const response = await proxyFetch(`${BACKEND_BASE_URL}/api/ops-calendar/events/${eventId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete event');
      }
      
      fetchEvents();
      setSelectedEvent(null);
      
      if (window.ZAFClient) {
        const client = window.ZAFClient.init();
        await client.invoke('notify', 'Event deleted successfully!', 'notice');
      }
      
    } catch (err) {
      console.error('[OPS Calendar] Error deleting event:', err);
      setError('Failed to delete event');
    }
  };

  const toggleDayExpansion = (day) => {
    setExpandedDays(prev => ({
      ...prev,
      [day]: !prev[day]
    }));
  };

  const getEventTypeStyle = (type) => {
    const styles = {
      meeting: { bg: '#E8F0FE', color: '#1967D2', icon: '👥' },
      maintenance: { bg: '#FCEAEA', color: '#CC3340', icon: '🔧' },
      deployment: { bg: '#FEF7E0', color: '#F79A0A', icon: '🚀' },
      training: { bg: '#E8F5E8', color: '#2E7D0F', icon: '📚' },
      outage: { bg: '#FFE4DB', color: '#FF6D00', icon: '⚠️' },
      other: { bg: '#F5F5F5', color: '#616161', icon: '📌' }
    };
    return styles[type] || styles.other;
  };

  const formatTime = (dateTime) => {
    if (!dateTime) return '';
    const date = new Date(dateTime);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString + ' 00:00:00');
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return 'Tomorrow';
    } else {
      return date.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric' 
      });
    }
  };

  if (loading && !refreshing) {
    return (
      <div style={{ 
        padding: '20px', 
        textAlign: 'center',
        color: '#68737D'
      }}>
        Loading calendar events...
      </div>
    );
  }

  return (
    <div style={{
      backgroundColor: '#FFFFFF',
      border: '1px solid #D8DCDE',
      borderRadius: '8px',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
    }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid #D8DCDE',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '20px' }}>📅</span>
          <span style={{ fontSize: '14px', fontWeight: '600', color: '#2F3941' }}>
            OPS Calendar
          </span>
        </div>
        
        <div style={{ display: 'flex', gap: '8px' }}>
          {/* View Toggle */}
          <select
            value={view}
            onChange={(e) => setView(e.target.value)}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              backgroundColor: '#FFFFFF',
              color: '#2F3941',
              cursor: 'pointer'
            }}
          >
            <option value="upcoming">Next 7 Days</option>
            <option value="month">Next 30 Days</option>
          </select>
          
          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              border: '1px solid #D8DCDE',
              borderRadius: '4px',
              backgroundColor: refreshing ? '#F8F9FA' : '#FFFFFF',
              color: '#68737D',
              cursor: refreshing ? 'not-allowed' : 'pointer'
            }}
          >
            {refreshing ? '↻' : '🔄'} Refresh
          </button>
          
          {/* Create Event Button */}
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              border: '1px solid #1F73B7',
              borderRadius: '4px',
              backgroundColor: '#1F73B7',
              color: '#FFFFFF',
              cursor: 'pointer'
            }}
          >
            + New Event
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div style={{
          padding: '12px 16px',
          backgroundColor: '#FBEAEA',
          borderBottom: '1px solid #CC3340',
          color: '#CC3340',
          fontSize: '12px'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* Create Event Form */}
      {showCreateForm && (
        <div style={{
          padding: '16px',
          backgroundColor: '#F8F9FA',
          borderBottom: '1px solid #D8DCDE'
        }}>
          <div style={{
            fontSize: '13px',
            fontWeight: '600',
            color: '#2F3941',
            marginBottom: '12px'
          }}>
            Create New Event
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <input
                type="text"
                placeholder="Event Title"
                value={newEvent.summary}
                onChange={(e) => setNewEvent({...newEvent, summary: e.target.value})}
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
              <input
                type="datetime-local"
                value={newEvent.startDateTime}
                onChange={(e) => setNewEvent({...newEvent, startDateTime: e.target.value})}
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
              <input
                type="datetime-local"
                value={newEvent.endDateTime}
                onChange={(e) => setNewEvent({...newEvent, endDateTime: e.target.value})}
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
              <select
                value={newEvent.eventType}
                onChange={(e) => setNewEvent({...newEvent, eventType: e.target.value})}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="meeting">Meeting</option>
                <option value="maintenance">Maintenance</option>
                <option value="deployment">Deployment</option>
                <option value="training">Training</option>
                <option value="outage">Outage</option>
                <option value="other">Other</option>
              </select>
            </div>
            
            <div>
              <input
                type="text"
                placeholder="Location (optional)"
                value={newEvent.location}
                onChange={(e) => setNewEvent({...newEvent, location: e.target.value})}
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
            
            <div style={{ gridColumn: '1 / -1' }}>
              <textarea
                placeholder="Description (optional)"
                value={newEvent.description}
                onChange={(e) => setNewEvent({...newEvent, description: e.target.value})}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #D8DCDE',
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  minHeight: '60px',
                  resize: 'vertical'
                }}
              />
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setShowCreateForm(false)}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                border: '1px solid #D8DCDE',
                borderRadius: '4px',
                backgroundColor: '#FFFFFF',
                color: '#68737D',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleCreateEvent}
              disabled={!newEvent.summary || !newEvent.startDateTime || !newEvent.endDateTime}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                border: '1px solid #1F73B7',
                borderRadius: '4px',
                backgroundColor: newEvent.summary && newEvent.startDateTime && newEvent.endDateTime ? '#1F73B7' : '#D8DCDE',
                color: '#FFFFFF',
                cursor: newEvent.summary && newEvent.startDateTime && newEvent.endDateTime ? 'pointer' : 'not-allowed'
              }}
            >
              Create Event
            </button>
          </div>
        </div>
      )}

      {/* Events List */}
      <div style={{ padding: '16px' }}>
        {Object.keys(events).length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '20px',
            color: '#68737D',
            fontSize: '12px'
          }}>
            No events scheduled for the selected period
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {Object.entries(events).map(([day, dayEvents]) => {
              const isExpanded = expandedDays[day] !== false; // Default to expanded
              const dateLabel = formatDate(day);
              
              return (
                <div key={day} style={{
                  border: '1px solid #D8DCDE',
                  borderRadius: '6px',
                  overflow: 'hidden'
                }}>
                  {/* Day Header */}
                  <div
                    onClick={() => toggleDayExpansion(day)}
                    style={{
                      padding: '8px 12px',
                      backgroundColor: '#F8F9FA',
                      borderBottom: isExpanded ? '1px solid #D8DCDE' : 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{
                        fontSize: '12px',
                        fontWeight: '600',
                        color: dateLabel === 'Today' ? '#1F73B7' : '#2F3941'
                      }}>
                        {dateLabel}
                      </span>
                      <span style={{
                        fontSize: '10px',
                        color: '#68737D',
                        backgroundColor: '#FFFFFF',
                        padding: '2px 6px',
                        borderRadius: '10px'
                      }}>
                        {dayEvents.length} event{dayEvents.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <span style={{ fontSize: '10px', color: '#68737D' }}>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  </div>
                  
                  {/* Day Events */}
                  {isExpanded && (
                    <div style={{ padding: '8px' }}>
                      {dayEvents.map((event, idx) => {
                        const typeStyle = getEventTypeStyle(event.eventType);
                        
                        return (
                          <div
                            key={event.id}
                            style={{
                              padding: '8px',
                              borderRadius: '4px',
                              backgroundColor: typeStyle.bg,
                              marginBottom: idx < dayEvents.length - 1 ? '6px' : '0',
                              border: `1px solid ${typeStyle.color}20`,
                              cursor: 'pointer'
                            }}
                            onClick={() => setSelectedEvent(event)}
                          >
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                              <span style={{ fontSize: '14px' }}>{typeStyle.icon}</span>
                              <div style={{ flex: 1 }}>
                                <div style={{
                                  fontSize: '12px',
                                  fontWeight: '600',
                                  color: typeStyle.color,
                                  marginBottom: '4px'
                                }}>
                                  {event.summary}
                                </div>
                                <div style={{
                                  fontSize: '11px',
                                  color: '#68737D',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '12px'
                                }}>
                                  {!event.isAllDay && (
                                    <span>
                                      🕐 {formatTime(event.start.dateTime)} - {formatTime(event.end.dateTime)}
                                    </span>
                                  )}
                                  {event.isAllDay && <span>📅 All day</span>}
                                  {event.location && <span>📍 {event.location}</span>}
                                  {event.attendees > 0 && <span>👥 {event.attendees}</span>}
                                </div>
                              </div>
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
        )}
      </div>
    </div>
  );
}

export default OPSCalendarComponent;