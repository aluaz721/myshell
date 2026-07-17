CC      = gcc
CFLAGS  = -Wall -Wextra -Werror -std=c99 -pedantic
TARGET  = minishell
SRC     = minishell.c

.PHONY: all clean debug

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $<

debug: CFLAGS += -g -fsanitize=address,undefined
debug: $(TARGET)

clean:
	rm -f $(TARGET)