#ifndef SECURECHANNEL_DIALECT_H
#define SECURECHANNEL_DIALECT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
    SC_ACTION_SEND_TEXT = 1,
    SC_ACTION_SEND_BINARY = 2,
    SC_ACTION_DROPPED = 3,
    SC_ACTION_SUCCEEDED = 4,
    SC_ACTION_FAILED = 5,
    SC_NOTICE_CONNECTING = 10,
    SC_NOTICE_ONLINE = 11,
    SC_NOTICE_OFFLINE = 12,
    SC_NOTICE_NODES = 13,
    SC_NOTICE_IMPORT = 14,
    SC_NOTICE_READY = 15,
    SC_NOTICE_LATENCY = 16,
    SC_NOTICE_TYPED_DATA = 17,
    SC_NOTICE_EXCEPTION = 18,
    SC_NOTICE_STREAMS = 19,
    SC_NOTICE_STREAM_UP = 20,
    SC_NOTICE_STREAM_DOWN = 21,
    SC_NOTICE_STREAM_CLOSED = 22,
    SC_NOTICE_STREAM_BYTES = 23
};

typedef struct ScDialect ScDialect;

typedef struct ScAction {
    const uint8_t *body;
    size_t body_length;
    uint64_t key;
    uint32_t kind;
    const uint8_t *name;
    size_t name_length;
    double seconds;
} ScAction;

ScDialect *sc_dialect_new(void);
void sc_dialect_free(ScDialect *dialect);

void sc_dialect_opened(ScDialect *dialect);
void sc_dialect_closed(ScDialect *dialect);
void sc_dialect_text(ScDialect *dialect, const uint8_t *frame, size_t length);
void sc_dialect_binary(ScDialect *dialect, const uint8_t *frame, size_t length);

uint64_t sc_dialect_call(ScDialect *dialect, const uint8_t *command, size_t command_length, const uint8_t *arguments, size_t arguments_length);
void sc_dialect_cancel(ScDialect *dialect, uint64_t key);
void sc_dialect_expire(ScDialect *dialect, uint64_t key, uint64_t waited_milliseconds);

void sc_dialect_open_stream(ScDialect *dialect, const uint8_t *stream, size_t length);
void sc_dialect_close_stream(ScDialect *dialect, const uint8_t *stream, size_t length);
void sc_dialect_write_stream(ScDialect *dialect, const uint8_t *stream, size_t stream_length, const uint8_t *payload, size_t payload_length);
bool sc_dialect_is_stream_up(ScDialect *dialect, const uint8_t *stream, size_t length);

void sc_dialect_rename_session(ScDialect *dialect, const uint8_t *session, size_t length);
void sc_dialect_request_new_session(ScDialect *dialect);

bool sc_dialect_is_live(ScDialect *dialect);
uint64_t sc_dialect_liveness_seconds(ScDialect *dialect);
uint64_t sc_dialect_reconnect_delay_seconds(ScDialect *dialect);

bool sc_dialect_next_action(ScDialect *dialect, ScAction *action);

#endif
