#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* A transport-only driver: it never loads accessibility or capture APIs. */
static void *flood(void *unused) {
  (void)unused;
  fputs("{\"jsonrpc\":\"2.0\",\"method\":\"fixture/bulk\",\"params\":{\"data\":\"", stdout);
  for (int i = 0; i < 8 * 1024 * 1024; i++) fputc('x', stdout);
  fputs("\"}}\n", stdout);
  fflush(stdout);
  fputs("flood-written\n", stderr);
  return NULL;
}

int main(void) {
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  puts("{\"jsonrpc\":\"2.0\",\"method\":\"fixture/ready\"}");
  fflush(stdout);
  while ((length = getline(&line, &capacity, stdin)) >= 0) {
    if (strstr(line, "fixture/flood")) {
      pthread_t writer;
      if (pthread_create(&writer, NULL, flood, NULL) != 0) return 70;
      pthread_detach(writer);
    } else if (strstr(line, "notifications/cancelled")) {
      fputs("cancel-received\n", stderr);
    } else if (strstr(line, "fixture/hold")) {
      fputs("holding\n", stderr);
      for (;;) pause();
    } else if (strstr(line, "fixture/scalar-reply")) {
      puts("{\"text\":\"\\ud800\",\"low\":\"\\udc00\",\"value\":1e400}");
      fflush(stdout);
    } else if (strstr(line, "fixture/invalid-reply")) {
      if (strstr(line, "trailing")) puts("{\"value\":[1,]}");
      else if (strstr(line, "bom")) puts("\xef\xbb\xbf{}");
      else puts("[]");
      fflush(stdout);
    } else if (strstr(line, "fixture/tail")) {
      fputs("{\"jsonrpc\":\"2.0\",\"id\":\"tail\",\"result\":{\"ok\":true}}", stdout);
      fflush(stdout);
      free(line);
      return 7;
    } else {
      fwrite(line, 1, (size_t)length, stdout);
      fflush(stdout);
    }
  }
  free(line);
  return 0;
}
