/* motor_pid — bare-metal Cortex-M3 velocity PID for the Renode×Newton co-sim.
 *
 * The electronic half of the multi-domain loop. Register addresses are the
 * real STM32F103 ones (from the register-map asset):
 *   TIM3.CNT  (0x40000424)  <- sim_bridge writes measured motor speed [rad/s x100]
 *   TIM1.CCR1 (0x40012C34)  -> PID output duty 0..1000, bridge reads as motor drive
 *   GPIOC.ODR (0x4001100C)  -> bit13 heartbeat (observable liveness probe)
 */
#include <stdint.h>

#define REG(addr) (*(volatile uint32_t *)(addr))
#define TIM3_CNT  0x40000424u /* encoder feedback: speed [rad/s x100] */
#define TIM1_CCR1 0x40012C34u /* PWM duty out: 0..1000 */
#define GPIOC_ODR 0x4001100Cu

#define TARGET_X100 1200u /* target speed: 12.00 rad/s (steady duty ~800/1000) */

static void delay(volatile uint32_t n) { while (n--) { __asm volatile("nop"); } }

void main(void) {
  int32_t integ = 0;
  uint32_t tick = 0;
  for (;;) {
    int32_t meas = (int32_t)REG(TIM3_CNT);        /* rad/s x100 */
    int32_t err = (int32_t)TARGET_X100 - meas;
    integ += err;
    /* anti-windup: steady duty ~800 needs I-term ~800 => integ up to ~640k */
    if (integ > 1000000) integ = 1000000;
    if (integ < -1000000) integ = -1000000;
    /* duty = Kp*err + Ki*integ, scaled to 0..1000 */
    int32_t duty = (err * 40 + integ / 8) / 100;
    if (duty < 0) duty = 0;
    if (duty > 1000) duty = 1000;
    REG(TIM1_CCR1) = (uint32_t)duty;
    REG(GPIOC_ODR) = (++tick & 1u) << 13; /* PC13 heartbeat */
    delay(200);
  }
}

/* ── vector table + reset ── */
extern uint32_t _estack;
void Reset_Handler(void) { main(); for (;;) {} }

__attribute__((section(".isr_vector"), used))
static void (*const vectors[])(void) = {
  (void (*)(void))(&_estack),
  Reset_Handler,
};
